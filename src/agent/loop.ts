import Anthropic from '@anthropic-ai/sdk';
import { Session } from './session';
import { TOOL_DEFINITIONS, ToolContext, executeTool } from './tools';
import { SYSTEM_PROMPT, MINIMAL_OUTPUT_ADDENDUM } from './prompt';
import { addUsage, supportsAdaptiveThinking, supportsEffort } from './models';

export interface TurnEvents {
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onToolResult: (name: string, ok: boolean, preview: string) => void;
  /** model is the model that actually served the request — may differ from
   *  session.model when Fable's server-side fallback silently serves Opus. */
  onRequestDone: (usage: Anthropic.Usage, model: string) => void;
  onNotice: (message: string) => void;
  /** Live activity signal: current phase + approximate output tokens this turn. */
  onProgress: (phase: string, approxTokens: number) => void;
  /** Extended-thinking text as it streams in (summarized display). Optional: not all backends emit it. */
  onThinking?: (delta: string) => void;
}

export interface TurnResult {
  stopReason: string | null;
  finalText: string;
}

const MAX_TOOL_ROUNDS = 40;
const PROGRESS_INTERVAL_MS = 300;
/** Rough chars-per-token for progress display only (never for billing). */
const CHARS_PER_TOKEN = 4;

/**
 * Run one user turn: send the message, execute tool calls until the model
 * stops asking for them. Prompt-cache discipline lives here:
 *  - frozen system prompt + stable tool list (never touched per-request)
 *  - a cache breakpoint moved to the tail of the conversation each request
 */
export async function runTurn(
  client: Anthropic,
  session: Session,
  userContent: string,
  toolCtx: ToolContext,
  maxTokens: number,
  events: TurnEvents,
  signal: AbortSignal,
  minimizeOutput = false
): Promise<TurnResult> {
  session.messages.push({
    role: 'user',
    content: [{ type: 'text', text: userContent }],
  });

  let finalText = '';
  let stopReason: string | null = null;

  // Turn-level progress counter: approximated from streamed chars, re-synced
  // to the real usage numbers at the end of every request.
  let approxChars = 0;
  let realOutputTokens = 0;
  let lastEmit = 0;
  let lastPhase = '';
  const progress = (phase: string, chars: number, force = false) => {
    approxChars += chars;
    const now = Date.now();
    if (force || phase !== lastPhase || now - lastEmit > PROGRESS_INTERVAL_MS) {
      lastPhase = phase;
      lastEmit = now;
      events.onProgress(phase, realOutputTokens + Math.round(approxChars / CHARS_PER_TOKEN));
    }
  };

  progress('sending request', 0, true);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      throw new Error('cancelled');
    }
    placeCacheMarkers(session.messages);

    const response = await streamOnce(client, session, maxTokens, events, signal, progress, minimizeOutput);

    addUsage(session.totals, response.usage);
    session.lastInputTokens =
      (response.usage.input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0);
    // Re-sync the approximate counter to reality.
    realOutputTokens += response.usage.output_tokens ?? 0;
    approxChars = 0;
    events.onRequestDone(response.usage, response.model);

    // Echo the assistant content back verbatim (thinking blocks included).
    session.messages.push({ role: 'assistant', content: response.content as any });
    stopReason = response.stop_reason;

    for (const block of response.content) {
      if (block.type === 'text') {
        finalText = block.text;
      }
    }

    if (stopReason === 'refusal') {
      events.onNotice(
        'The model declined this request (safety refusal). Try rephrasing, or escalate — Fable requests fall back to Opus automatically.'
      );
      break;
    }

    if (stopReason === 'max_tokens') {
      events.onNotice('Response hit the max_tokens limit and was truncated. Say "continue" to resume.');
      break;
    }

    if (stopReason === 'pause_turn') {
      continue; // server asks us to re-send and resume
    }

    if (stopReason !== 'tool_use') {
      break; // end_turn
    }

    // Execute all requested tools concurrently, return results in ONE user message.
    progress('running tools', 0, true);
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        events.onToolUse(tu.name, tu.input);
        const outcome = await executeTool(toolCtx, tu.name, tu.input);
        events.onToolResult(tu.name, !outcome.isError, outcome.content.slice(0, 200));
        return {
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: outcome.content,
          is_error: outcome.isError,
        };
      })
    );
    session.messages.push({ role: 'user', content: results });
    progress('sending request', 0, true);
  }

  return { stopReason, finalText };
}

async function streamOnce(
  client: Anthropic,
  session: Session,
  maxTokens: number,
  events: TurnEvents,
  signal: AbortSignal,
  progress: (phase: string, chars: number, force?: boolean) => void,
  minimizeOutput = false
): Promise<Anthropic.Message> {
  const common = {
    model: session.model,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text' as const,
        // Both parts are frozen constants, so the cache prefix stays stable
        // for as long as the minimizeOutputTokens setting is unchanged.
        text: minimizeOutput ? SYSTEM_PROMPT + MINIMAL_OUTPUT_ADDENDUM : SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    tools: TOOL_DEFINITIONS,
    messages: session.messages,
    ...(supportsEffort(session.model) ? { output_config: { effort: session.effort } } : {}),
    // Summarized display makes thinking stream as text deltas, so the UI can
    // show live progress instead of a silent pause. Billing is unchanged.
    // Thinking tokens are billed as output, so minimize mode skips thinking.
    ...(supportsAdaptiveThinking(session.model) && !minimizeOutput
      ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
      : {}),
  };

  const trackProgress = (event: any) => {
    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (d?.type === 'thinking_delta') {
        progress('thinking', (d.thinking ?? '').length);
        events.onThinking?.(d.thinking ?? '');
      } else if (d?.type === 'text_delta') {
        progress('writing', (d.text ?? '').length);
      } else if (d?.type === 'input_json_delta') {
        progress('preparing tool call', (d.partial_json ?? '').length);
      }
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      progress('thinking', 0, true);
    }
  };

  if (session.model === 'claude-fable-5') {
    // Fable: opt into server-side refusal fallback so benign-adjacent work
    // degrades to Opus instead of failing.
    const stream = client.beta.messages.stream(
      {
        ...(common as any),
        betas: ['server-side-fallback-2026-06-01'],
        fallbacks: [{ model: 'claude-opus-4-8' }],
      },
      { signal }
    );
    stream.on('text', events.onText);
    stream.on('streamEvent', trackProgress);
    const message = await stream.finalMessage();
    return message as unknown as Anthropic.Message;
  }

  const stream = client.messages.stream(common as Anthropic.MessageStreamParams, { signal });
  stream.on('text', events.onText);
  stream.on('streamEvent', trackProgress);
  return stream.finalMessage();
}

/**
 * Move the conversation-tail cache breakpoints. We keep markers on the last
 * block of the last two user messages (the second one guards against the
 * 20-block lookback limit on long tool turns), plus the permanent one on the
 * system prompt. 3 breakpoints total, under the API's limit of 4.
 */
function placeCacheMarkers(messages: Anthropic.MessageParam[]): void {
  const CACHEABLE = new Set(['text', 'tool_result', 'image', 'document', 'tool_use']);
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        delete (block as any).cache_control;
      }
    }
  }
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) {
      continue;
    }
    const last = msg.content[msg.content.length - 1] as any;
    if (CACHEABLE.has(last.type)) {
      last.cache_control = { type: 'ephemeral' };
      marked++;
    }
  }
}
