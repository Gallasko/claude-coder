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

const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description:
        'A git commit message: an imperative-mood subject line (max ~72 chars) summarizing the change made in this chat, ' +
        'optionally followed by a blank line and a short body for non-obvious context.',
    },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call that turns the current session's transcript into a git
 * commit message — used by /commit when the user doesn't supply one.
 */
export async function summarizeCommitMessage(client: Anthropic, session: Session, totals: UsageTotals): Promise<string> {
  const transcript = buildTranscript(session).slice(-8000);
  if (!transcript.trim()) {
    throw new Error('no transcript to summarize');
  }
  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 200,
    output_config: { format: { type: 'json_schema', schema: COMMIT_MESSAGE_SCHEMA as any } },
    messages: [
      {
        role: 'user',
        content: [
          'Write a git commit message for the change made in this coding-agent chat session.',
          session.taskSummary ? `Task: ${session.taskSummary}` : '',
          `Transcript excerpt (most recent last):\n"""${transcript}"""`,
          '',
          'Focus on what changed and why, not the conversation itself.',
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
  return (JSON.parse(text.text) as { message: string }).message.trim();
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

const FILE_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Concise digest for a coding agent deciding whether it needs the full file: purpose, exported/public API, ' +
        'key functions or classes with signatures, notable dependencies, and any TODOs.',
    },
  },
  required: ['summary'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call that turns a file's content into a short digest — stored
 * in MemoryStore (see memory.ts) and served instead of the raw file on later
 * read_file calls, as long as the file hasn't changed (see tools.ts).
 */
export async function summarizeFile(
  client: Anthropic,
  filePath: string,
  content: string,
  totals: UsageTotals
): Promise<string | undefined> {
  const trimmed = content.slice(0, 20_000);
  if (!trimmed.trim()) {
    return undefined;
  }
  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 400,
    output_config: { format: { type: 'json_schema', schema: FILE_SUMMARY_SCHEMA as any } },
    messages: [
      {
        role: 'user',
        content: [
          `Summarize this file for a coding agent's lazy read cache: ${filePath}`,
          `"""${trimmed}"""`,
        ].join('\n\n'),
      },
    ],
  });
  addUsage(totals, response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    return undefined;
  }
  return (JSON.parse(text.text) as { summary: string }).summary;
}

function buildTranscript(session: Session): string {
  if (session.backend === 'subscription') {
    return session.assistantLog.join('\n\n');
  }
  return session.messages.map((m) => `${m.role}: ${extractText(m)}`).join('\n\n');
}
