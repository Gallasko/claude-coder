import type Anthropic from '@anthropic-ai/sdk';

/** USD per million tokens. cacheRead = 0.1x input, cacheWrite (5m TTL) = 1.25x input. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};

export const CLASSIFIER_MODEL = 'claude-haiku-4-5';

/** Models that accept output_config.effort (Haiku 4.5 does not). */
export function supportsEffort(model: string): boolean {
  return model !== 'claude-haiku-4-5';
}

/**
 * Extended thinking is reserved for the reasoning tier (Opus/Fable) — that's
 * where planning happens. Sonnet's job is mechanical implementation off an
 * already-made plan, so it skips thinking entirely: thinking tokens are
 * billed as output at the same 5x rate as everything else, and Sonnet
 * shouldn't need to "think out loud" to follow a plan it was handed.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  return model === 'claude-opus-4-8' || model === 'claude-fable-5';
}

export function displayName(model: string): string {
  const names: Record<string, string> = {
    'claude-haiku-4-5': 'Haiku 4.5',
    'claude-sonnet-5': 'Sonnet 5',
    'claude-opus-4-8': 'Opus 4.8',
    'claude-fable-5': 'Fable 5',
  };
  return names[model] ?? model;
}

export type Complexity = 'trivial' | 'standard' | 'hard';

/**
 * Implementation always runs on Sonnet at low or high effort — `xhigh` is
 * reserved for the manual escalation ladder. Hard tasks get their deep
 * reasoning from a separate Opus/Fable planning pass (see planner.ts)
 * instead of cranking Sonnet's own effort/thinking up.
 */
export const EFFORT_BY_COMPLEXITY: Record<Complexity, 'low' | 'high'> = {
  trivial: 'low',
  standard: 'high',
  hard: 'high',
};

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
}

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
}

export function addUsage(totals: UsageTotals, usage: Anthropic.Usage, requests = 1): void {
  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  totals.requests += requests;
}

/** Cost in USD for accumulated totals on a given model. */
export function costUsd(totals: UsageTotals, model: string): number {
  // Tolerate dated/suffixed variants (e.g. "claude-haiku-4-5-20251001").
  const p = PRICING[model] ?? Object.entries(PRICING).find(([k]) => model.startsWith(k))?.[1];
  if (!p) {
    return 0;
  }
  return (
    (totals.inputTokens * p.input +
      totals.outputTokens * p.output +
      totals.cacheReadTokens * p.cacheRead +
      totals.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

export function formatUsd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
