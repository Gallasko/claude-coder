import Anthropic from '@anthropic-ai/sdk';
import { Session, extractText } from './session';
import { runHaikuTask, HaikuTaskResult } from './sdkBackend';

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

export type SummaryTaskResult<T> = HaikuTaskResult & { data: T };

/**
 * Cheap end-of-task Haiku call (subscription-first, credits fallback — see
 * sdkBackend.ts runHaikuTask) that turns a finished session's transcript
 * into a durable summary — stored in SummaryStore as the chat's "memory" for
 * the project history view.
 */
export async function summarizeSession(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  session: Session
): Promise<SummaryTaskResult<ChatSummary>> {
  const transcript = buildTranscript(session).slice(-8000);
  if (!transcript.trim()) {
    const data = { summary: session.taskSummary || '(no activity)', highlights: [] };
    return { data, text: '', structured: data, backend: 'credits', usage: emptyUsage(), estValueUsd: 0 };
  }
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: SCHEMA,
    maxTokens: 400,
    prompt: [
      'Summarize this finished coding-agent chat session for a project history log.',
      session.taskSummary ? `Task: ${session.taskSummary}` : '',
      `Transcript excerpt (most recent last):\n"""${transcript}"""`,
      '',
      'Write a concise summary of what was accomplished (or attempted) and list key highlights.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  return { ...result, data: (result.structured ?? JSON.parse(result.text)) as ChatSummary };
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
 * Cheap Haiku call (subscription-first, credits fallback) that turns the
 * current session's transcript into a git commit message — used by /commit
 * when the user doesn't supply one.
 */
export async function summarizeCommitMessage(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  session: Session
): Promise<SummaryTaskResult<string>> {
  const transcript = buildTranscript(session).slice(-8000);
  if (!transcript.trim()) {
    throw new Error('no transcript to summarize');
  }
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: COMMIT_MESSAGE_SCHEMA,
    maxTokens: 200,
    prompt: [
      'Write a git commit message for the change made in this coding-agent chat session.',
      session.taskSummary ? `Task: ${session.taskSummary}` : '',
      `Transcript excerpt (most recent last):\n"""${transcript}"""`,
      '',
      'Focus on what changed and why, not the conversation itself.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const parsed = (result.structured ?? JSON.parse(result.text)) as { message: string };
  return { ...result, data: parsed.message.trim() };
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
 * Cheap Haiku call (subscription-first, credits fallback) that picks which
 * past chats in a project (if any) are relevant to a new task — so a fresh
 * chat can reuse the right memories instead of just the most recent ones.
 */
export async function findRelevantChats(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  upcomingTask: string,
  candidates: ChatCandidate[],
  limit = 5
): Promise<SummaryTaskResult<number[]>> {
  if (candidates.length === 0) {
    return { data: [], text: '', structured: [], backend: 'credits', usage: emptyUsage(), estValueUsd: 0 };
  }
  const list = candidates
    .map((c) => `#${c.chatId}: ${c.summary}${c.highlights.length ? ` (${c.highlights.join('; ')})` : ''}`)
    .join('\n');
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: RECALL_SCHEMA,
    maxTokens: 200,
    prompt: [
      'A new chat is starting in this project. Decide which past chats, if any, are directly relevant or helpful for it.',
      `Upcoming task:\n"""${upcomingTask.slice(0, 2000)}"""`,
      `Past chats in this project:\n${list}`,
      `Return at most ${limit} chat IDs, most relevant first. Return an empty array if none are clearly helpful — don't force irrelevant matches.`,
    ].join('\n\n'),
  });
  const parsed = (result.structured ?? JSON.parse(result.text)) as { relevantChatIds: number[] };
  return { ...result, data: parsed.relevantChatIds.slice(0, limit) };
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

const FILE_SUMMARY_DETAILED_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Detailed digest for a coding agent that reads this file often: purpose, exported/public API, per-function ' +
        'or per-class behavior (params, returns, side effects), key invariants or gotchas, notable dependencies, and ' +
        'any TODOs. Go deeper than a quick digest — this file is read frequently, so the extra detail pays for itself.',
    },
  },
  required: ['summary'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call (subscription-first, credits fallback) that turns a
 * file's content into a short digest — stored in MemoryStore (see memory.ts)
 * and served instead of the raw file on later read_file calls, as long as
 * the file hasn't changed (see tools.ts).
 */
export async function summarizeFile(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  filePath: string,
  content: string,
  detailed = false
): Promise<SummaryTaskResult<string> | undefined> {
  const trimmed = content.slice(0, 20_000);
  if (!trimmed.trim()) {
    return undefined;
  }
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: detailed ? FILE_SUMMARY_DETAILED_SCHEMA : FILE_SUMMARY_SCHEMA,
    maxTokens: detailed ? 900 : 400,
    prompt: [
      detailed
        ? `Write a detailed digest of this frequently-read file for a coding agent's lazy read cache: ${filePath}`
        : `Summarize this file for a coding agent's lazy read cache: ${filePath}`,
      `"""${trimmed}"""`,
    ].join('\n\n'),
  });
  const parsed = (result.structured ?? JSON.parse(result.text)) as { summary: string };
  return { ...result, data: parsed.summary };
}

const PLANNING_CONDENSE_SCHEMA = {
  type: 'object',
  properties: {
    relevant: {
      type: 'string',
      description:
        'Only the parts of this file relevant to the planning task: signatures, relevant functions, and structure. ' +
        'Drop unrelated code, comments, and boilerplate. Preserve line-number references where useful.',
    },
  },
  required: ['relevant'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call that condenses a file down to what's relevant to a
 * specific planning task, before it reaches the reasoning-tier model doing
 * the planning (see tools.ts readFileTool, controller.ts planIfNeeded).
 * Distinct from summarizeFile's whole-file digest, which isn't task-aware.
 */
export async function preprocessFileForPlanning(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  filePath: string,
  content: string,
  task: string
): Promise<SummaryTaskResult<string>> {
  const trimmed = content.slice(0, 20_000);
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: PLANNING_CONDENSE_SCHEMA,
    maxTokens: 600,
    prompt: [
      `Planning task: ${task.slice(0, 2000)}`,
      `Given this planning task, extract only the parts of this file a planner needs: ${filePath}`,
      `"""${trimmed}"""`,
    ].join('\n\n'),
  });
  const parsed = (result.structured ?? JSON.parse(result.text)) as { relevant: string };
  return { ...result, data: parsed.relevant };
}

export interface TaskMemoryDraft {
  summary: string;
  keyPoints: string[];
}

const TASK_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: '2-4 sentences: what was done, why, and how — enough for a future task on these files to skip rediscovering it',
    },
    keyPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 5 short bullet points: key decisions, gotchas, or file responsibilities worth remembering',
    },
  },
  required: ['summary', 'keyPoints'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call that turns a task's transcript + touched files into a
 * durable task memory — stored in TaskMemoryStore (see taskMemoryStore.ts) so
 * a later task on the same files can reuse it as context instead of
 * rediscovering the code through read/glob/grep round trips. Pass
 * `previousSummary` to refresh an existing memory mid-task rather than
 * starting over.
 */
export async function createTaskMemory(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  session: Session,
  touchedFiles: string[],
  previousSummary?: string
): Promise<SummaryTaskResult<TaskMemoryDraft>> {
  const transcript = buildTranscript(session).slice(-8000);
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: TASK_MEMORY_SCHEMA,
    maxTokens: 400,
    prompt: [
      previousSummary
        ? `Update this project task memory with what happened since it was last written.\nPrevious memory:\n"""${previousSummary}"""`
        : 'Write a durable task memory for a coding agent working on this project.',
      session.taskSummary ? `Task: ${session.taskSummary}` : '',
      touchedFiles.length ? `Files touched:\n${touchedFiles.map((f) => `- ${f}`).join('\n')}` : '',
      `Transcript excerpt (most recent last):\n"""${transcript}"""`,
      '',
      'Summarize what was done, why, and how, plus any key points a future task on these files should know.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const parsed = (result.structured ?? JSON.parse(result.text)) as TaskMemoryDraft;
  return { ...result, data: parsed };
}

export interface TaskMemoryCandidate {
  id: number;
  title: string;
  summary: string;
}

const MEMORY_RECALL_SCHEMA = {
  type: 'object',
  properties: {
    relevantIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'IDs of task memories directly useful for the upcoming task, most relevant first. Empty if none are clearly relevant.',
    },
  },
  required: ['relevantIds'],
  additionalProperties: false,
} as const;

/**
 * Cheap Haiku call that picks which task memories (if any) in a project are
 * relevant to an upcoming task, so a new task can fast-forward on files it
 * has already touched instead of rediscovering them. Falls back to recency
 * on error.
 */
export async function findRelevantMemories(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  upcomingTask: string,
  candidates: TaskMemoryCandidate[],
  limit = 5
): Promise<SummaryTaskResult<number[]>> {
  if (candidates.length === 0) {
    return { data: [], text: '', structured: [], backend: 'credits', usage: emptyUsage(), estValueUsd: 0 };
  }
  const list = candidates.map((c) => `#${c.id}: ${c.title} — ${c.summary}`).join('\n');
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: MEMORY_RECALL_SCHEMA,
    maxTokens: 200,
    prompt: [
      'A new task is starting in this project. Decide which past task memories, if any, are directly relevant or helpful for it.',
      `Upcoming task:\n"""${upcomingTask.slice(0, 2000)}"""`,
      `Task memories in this project:\n${list}`,
      `Return at most ${limit} memory IDs, most relevant first. Return an empty array if none are clearly helpful — don't force irrelevant matches.`,
    ].join('\n\n'),
  });
  const parsed = (result.structured ?? JSON.parse(result.text)) as { relevantIds: number[] };
  return { ...result, data: parsed.relevantIds.slice(0, limit) };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function buildTranscript(session: Session): string {
  if (session.backend === 'subscription') {
    return session.assistantLog.join('\n\n');
  }
  return session.messages.map((m) => `${m.role}: ${extractText(m)}`).join('\n\n');
}
