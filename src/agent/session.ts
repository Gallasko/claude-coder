import type Anthropic from '@anthropic-ai/sdk';
import { UsageTotals, emptyTotals, costUsd } from './models';

let nextId = 1;

/**
 * One session = one task = one conversation transcript on one model.
 * Escalation and task switches create a NEW session (fresh, cacheable
 * prompt) instead of continuing the transcript on a different model.
 */
export class Session {
  readonly id = nextId++;
  messages: Anthropic.MessageParam[] = [];
  totals: UsageTotals = emptyTotals();
  /** One-line description of the task, from the classifier or first message. */
  taskSummary = '';
  /** Notes carried over from a previous session (task switch or escalation). */
  carryOver: string | undefined;
  /** Terse plan drafted by the reasoning-tier model before Sonnet implements it. */
  plan: string | undefined;
  /** Last known total input size, to decide when to warn about context growth. */
  lastInputTokens = 0;
  /** Whole-file hashes already sent verbatim in this session's transcript. */
  readCache: Map<string, string> = new Map();

  constructor(
    public model: string,
    public effort: 'low' | 'medium' | 'high' | 'xhigh' = 'high'
  ) {}

  get cost(): number {
    return costUsd(this.totals, this.model);
  }

  get turns(): number {
    return this.messages.filter((m) => m.role === 'user').length;
  }
}

export class SessionManager {
  current: Session;
  /** Cost of finished sessions, so the day total survives resets. */
  private archivedCost = 0;
  private archivedRequests = 0;

  constructor(defaultModel: string) {
    this.current = new Session(defaultModel);
  }

  get totalCost(): number {
    return this.archivedCost + this.current.cost;
  }

  get totalRequests(): number {
    return this.archivedRequests + this.current.totals.requests;
  }

  /** Archive the current session and start a fresh one. */
  reset(model: string, effort?: Session['effort'], carryOver?: string): Session {
    this.archivedCost += this.current.cost;
    this.archivedRequests += this.current.totals.requests;
    this.current = new Session(model, effort ?? 'high');
    this.current.carryOver = carryOver;
    return this.current;
  }

  /**
   * Build carry-over notes for an escalation: what the task was and what the
   * smaller model already tried, so the bigger model doesn't repeat it.
   */
  buildEscalationCarryOver(): string {
    const s = this.current;
    const firstUser = s.messages.find((m) => m.role === 'user');
    const firstText = extractText(firstUser).slice(0, 1500);
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === 'assistant');
    const lastText = extractText(lastAssistant).slice(0, 2000);
    return [
      `You are taking over a task from a previous attempt that did not succeed.`,
      s.taskSummary ? `Task: ${s.taskSummary}` : '',
      firstText ? `Original request:\n${firstText}` : '',
      lastText ? `Where the previous attempt left off:\n${lastText}` : '',
      `Re-verify the current state of the files yourself before continuing — the previous attempt may have left partial changes.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

function extractText(msg: Anthropic.MessageParam | undefined): string {
  if (!msg) {
    return '';
  }
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .map((b) => ('text' in b && typeof (b as any).text === 'string' ? (b as any).text : ''))
    .filter(Boolean)
    .join('\n');
}
