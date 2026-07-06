import Anthropic from '@anthropic-ai/sdk';
import { CLASSIFIER_MODEL, Complexity, UsageTotals, addUsage } from './models';

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

/**
 * Cheap Haiku call (~$0.0005) that decides whether the incoming prompt starts
 * a NEW task (→ reset the session, save the cost of resending old context)
 * and rates its complexity (→ pick the effort level).
 */
export async function classifyPrompt(
  client: Anthropic,
  currentTaskSummary: string,
  userPrompt: string,
  classifierTotals: UsageTotals
): Promise<Classification> {
  const response = await client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 200,
    output_config: { format: { type: 'json_schema', schema: SCHEMA as any } },
    messages: [
      {
        role: 'user',
        content: [
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
      },
    ],
  });
  addUsage(classifierTotals, response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new Error('classifier returned no text');
  }
  return JSON.parse(text.text) as Classification;
}
