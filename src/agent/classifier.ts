import Anthropic from '@anthropic-ai/sdk';
import { Complexity } from './models';
import { runHaikuTask, HaikuTaskResult } from './sdkBackend';

export interface Classification {
  task: 'same' | 'new';
  complexity: Complexity;
  summary: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', enum: ['same', 'new'] },
    complexity: { type: 'string', enum: ['trivial', 'standard', 'hard'] },
    summary: { type: 'string', description: 'One line (max 15 words) describing the task the user is now working on' },
  },
  required: ['task', 'complexity', 'summary'],
  additionalProperties: false,
} as const;

export type ClassifyResult = HaikuTaskResult & { data: Classification };

/**
 * Cheap Haiku-tier call that decides whether the incoming prompt starts a
 * NEW task (→ reset the session, save the cost of resending old context)
 * and rates its complexity (→ pick the effort level). Subscription-first,
 * credits fallback — see sdkBackend.ts runHaikuTask.
 */
export async function classifyPrompt(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  currentTaskSummary: string,
  userPrompt: string
): Promise<ClassifyResult> {
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    schema: SCHEMA,
    maxTokens: 200,
    prompt: [
      'You route prompts for a coding agent.',
      currentTaskSummary
        ? `Current task in progress: ${currentTaskSummary}`
        : 'No task in progress yet.',
      `New user prompt:\n"""${userPrompt.slice(0, 2000)}"""`,
      '',
      'Decide:',
      '- task: "same" if this prompt continues/refines the current task (follow-ups, fixes, "also do X to the same code"). "new" if it is unrelated work. With no task in progress, always "new".',
      '- complexity: trivial (rename, typo, one-liner, simple question), standard (typical feature/bugfix in a few files), hard (cross-cutting refactor, tricky debugging, architecture).',
      '- summary: one line describing the task the user is now on.',
    ].join('\n'),
  });
  return { ...result, data: (result.structured ?? JSON.parse(result.text)) as Classification };
}
