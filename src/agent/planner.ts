import Anthropic from '@anthropic-ai/sdk';

const PLAN_SYSTEM =
  'You are the planning stage of a coding agent. Produce a short, concrete step-by-step plan for ' +
  'implementing the task: which file(s) to touch, the approach, and any risks/edge cases to check. ' +
  'No code, no preamble, no restating the task, no closing summary. Bullet points only, as terse as ' +
  'possible. A cheaper model will execute your plan and cannot ask you follow-up questions.';

export interface PlanResult {
  plan: string;
  usage: Anthropic.Usage;
}

/**
 * One-off, tool-free planning call on the reasoning-tier model (Opus/Fable).
 * `max_tokens` is capped hard by the caller — this is meant to be a compact
 * set of directions, not an essay. The strong model's output tokens are the
 * single most expensive line item in the whole pipeline, so this call is
 * deliberately short-leashed; the bulk of the (cheaper) work happens after,
 * on Sonnet, guided by this plan.
 */
export async function planTask(
  client: Anthropic,
  model: string,
  taskSummary: string,
  userPrompt: string,
  maxTokens: number
): Promise<PlanResult> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: PLAN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          taskSummary ? `Task: ${taskSummary}` : '',
          `Request:\n"""${userPrompt.slice(0, 4000)}"""`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  });
  const text = response.content.find((b) => b.type === 'text');
  return { plan: text && text.type === 'text' ? text.text.trim() : '', usage: response.usage };
}
