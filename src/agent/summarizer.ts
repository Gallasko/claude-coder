import Anthropic from '@anthropic-ai/sdk';
import { Session, extractText } from './session';
import { CLASSIFIER_MODEL, UsageTotals, addUsage } from './models';

export interface ChatSummary {
  summary: string;
  highlights: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-4 sentences summarizing what was accomplished (or attempted) in this chat' },
    highlights: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 5 short bullet points: key files touched, decisions made, or outstanding issues',
    },
  },
  required: ['summary', 'highlights'],
  additionalProperties: false,
} as const;

/**
 * Cheap end-of-task Haiku call that turns a finished session's transcript
 * into a durable summary — stored in SummaryStore as the chat's "memory"
 * for the project history view.
 */
export async function summarizeSession(
  client: Anthropic,
  session: Session,
  totals: UsageTotals
): Promise<ChatSummary> {
  const transcript = buildTranscript(session).slice(-8000);
  if (!transcript.trim()) {
    return { summary: session.taskSummary || '(no activity)', highlights: [] };
  }
  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 400,
    output_config: { format: { type: 'json_schema', schema: SCHEMA as any } },
    messages: [
      {
        role: 'user',
        content: [
          'Summarize this finished coding-agent chat session for a project history log.',
          session.taskSummary ? `Task: ${session.taskSummary}` : '',
          `Transcript excerpt (most recent last):\n"""${transcript}"""`,
          '',
          'Write a concise summary of what was accomplished (or attempted) and list key highlights.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });
  addUsage(totals, response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new Error('summarizer returned no text');
  }
  return JSON.parse(text.text) as ChatSummary;
}

export interface ChatCandidate {
  chatId: number;
  summary: string;
  highlights: string[];
}

const RECALL_SCHEMA = {
  type: 'object',
  properties: {
    relevantChatIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'IDs of past chats directly helpful for the upcoming task, most relevant first. Empty if none are clearly relevant.',
    },
  },
  required: ['relevantChatIds'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call that picks which past chats in a project (if any) are
 * relevant to a new task — so a fresh chat can reuse the right memories
 * instead of just the most recent ones.
 */
export async function findRelevantChats(
  client: Anthropic,
  totals: UsageTotals,
  upcomingTask: string,
  candidates: ChatCandidate[],
  limit = 5
): Promise<number[]> {
  if (candidates.length === 0) {
    return [];
  }
  const list = candidates
    .map((c) => `#${c.chatId}: ${c.summary}${c.highlights.length ? ` (${c.highlights.join('; ')})` : ''}`)
    .join('\n');
  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 200,
    output_config: { format: { type: 'json_schema', schema: RECALL_SCHEMA as any } },
    messages: [
      {
        role: 'user',
        content: [
          'A new chat is starting in this project. Decide which past chats, if any, are directly relevant or helpful for it.',
          `Upcoming task:\n"""${upcomingTask.slice(0, 2000)}"""`,
          `Past chats in this project:\n${list}`,
          `Return at most ${limit} chat IDs, most relevant first. Return an empty array if none are clearly helpful — don't force irrelevant matches.`,
        ].join('\n\n'),
      },
    ],
  });
  addUsage(totals, response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    return [];
  }
  const parsed = JSON.parse(text.text) as { relevantChatIds: number[] };
  return parsed.relevantChatIds.slice(0, limit);
}

function buildTranscript(session: Session): string {
  if (session.backend === 'subscription') {
    return session.assistantLog.join('\n\n');
  }
  return session.messages.map((m) => `${m.role}: ${extractText(m)}`).join('\n\n');
}
