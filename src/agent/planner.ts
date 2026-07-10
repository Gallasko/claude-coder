import Anthropic from '@anthropic-ai/sdk';
import { TOOL_DEFINITIONS, ToolContext, executeTool } from './tools';

const PLAN_SYSTEM =
  'You are the planning stage of a coding agent. You have read-only tools (grep, glob, read_file) — use them ' +
  'FIRST to ground the plan in the actual codebase: locate the files involved, read the parts you would touch, ' +
  'and verify real paths, names and signatures. Keep exploration tight — a handful of targeted lookups, not an ' +
  'audit. Whole-file reads may return a cached summary; that is usually enough for planning. ' +
  'Then output ONLY the final plan: short, concrete steps — exact file paths, the symbols/lines involved, the ' +
  'approach, and risks/edge cases to check. No code, no preamble, no restating the task, no closing summary. ' +
  'Bullet points only, as terse as possible. A cheaper model will execute your plan and cannot ask you ' +
  'follow-up questions — precision here saves its tokens.';

/** The subset of the shared tool set the planner may call — strictly read-only. */
const READ_ONLY_TOOLS = TOOL_DEFINITIONS.filter((t) => ['read_file', 'glob', 'grep'].includes(t.name));

export interface PlanResult {
  plan: string;
  usage: Anthropic.Usage;
  /** Number of read-only tool calls the planner made while exploring. */
  toolCalls: number;
}

export interface PlanOptions {
  /**
   * Enables codebase exploration. Reads route through the shared tool
   * executor, so they hit (and populate) the lazy summary cache and memory
   * tracking. Must carry its OWN readCache — the planner's transcript is
   * discarded, so "already sent this session" answers would dangle for the
   * executor. Omit for the old blind, tool-free plan.
   */
  toolCtx?: ToolContext;
  /** Exploration budget; the plan is forced once it runs out (default 8). */
  maxToolCalls?: number;
  /** Extra grounding prepended to the request (e.g. the project memory digest). */
  context?: string;
  signal?: AbortSignal;
  onToolUse?: (name: string, detail: string) => void;
}

/**
 * Planning call on the reasoning-tier model (Opus/Fable). With a toolCtx it
 * runs a short read-only exploration loop first (grep/glob/read_file), so
 * the plan cites real files and symbols instead of guesses — making the
 * cheaper executor's job mechanical — and every full read it makes seeds
 * the lazy summary cache for later turns. `max_tokens` stays capped by the
 * caller: the strong model's output tokens are the single most expensive
 * line item in the pipeline, and exploration rounds are mostly cheap
 * tool_use blocks.
 */
export async function planTask(
  client: Anthropic,
  model: string,
  taskSummary: string,
  userPrompt: string,
  maxTokens: number,
  opts: PlanOptions = {}
): Promise<PlanResult> {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  } as Anthropic.Usage;
  const addUsage = (u: Anthropic.Usage) => {
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_input_tokens =
      (usage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    usage.cache_creation_input_tokens =
      (usage.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  };

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        taskSummary ? `Task: ${taskSummary}` : '',
        opts.context ? `<project-memory>\n${opts.context}\n</project-memory>` : '',
        `Request:\n"""${userPrompt.slice(0, 4000)}"""`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  const maxToolCalls = opts.toolCtx ? opts.maxToolCalls ?? 8 : 0;
  let toolCalls = 0;

  for (;;) {
    const exploring = opts.toolCtx !== undefined && toolCalls < maxToolCalls;
    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: PLAN_SYSTEM,
        messages,
        ...(opts.toolCtx
          ? {
              tools: READ_ONLY_TOOLS,
              // Budget spent → the model must answer; tools stay in the
              // request because the transcript contains tool_use blocks.
              tool_choice: exploring ? { type: 'auto' as const } : { type: 'none' as const },
            }
          : {}),
      },
      { signal: opts.signal }
    );
    addUsage(response.usage);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    if (!exploring || toolUses.length === 0) {
      const text = response.content.find((b) => b.type === 'text');
      return { plan: text && text.type === 'text' ? text.text.trim() : '', usage, toolCalls };
    }

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ContentBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls += 1;
      opts.onToolUse?.(tu.name, previewToolInput(tu.input));
      const outcome = await executeTool(opts.toolCtx!, tu.name, tu.input);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }
    if (toolCalls >= maxToolCalls) {
      results.push({
        type: 'text',
        text: 'Exploration budget exhausted — write the final plan now from what you have.',
      });
    }
    messages.push({ role: 'user', content: results });
  }
}

function previewToolInput(input: unknown): string {
  const i = input as any;
  if (typeof i?.path === 'string') {
    return i.path;
  }
  if (typeof i?.pattern === 'string') {
    return i.pattern;
  }
  try {
    return JSON.stringify(i).slice(0, 120);
  } catch {
    return '';
  }
}
