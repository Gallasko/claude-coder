import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { SessionManager } from './agent/session';
import { runTurn } from './agent/loop';
import { classifyPrompt } from './agent/classifier';
import { PermissionRequest, ToolContext } from './agent/tools';
import {
  CLASSIFIER_MODEL,
  EFFORT_BY_COMPLEXITY,
  UsageTotals,
  costUsd,
  displayName,
  emptyTotals,
  formatUsd,
} from './agent/models';

/** Messages posted to the chat webview. */
export interface UiSink {
  post(message: Record<string, unknown>): void;
}

type PermissionChoice = 'yes' | 'always' | 'no';

const ALLOWED_STORE_KEY = 'claudeCoder.alwaysAllowed';

export class Controller {
  private client: Anthropic | undefined;
  readonly sessions: SessionManager;
  private classifierTotals: UsageTotals = emptyTotals();
  private abort: AbortController | undefined;
  private ui: UiSink | undefined;
  private statusBar: vscode.StatusBarItem;
  private log: vscode.OutputChannel;
  private busy = false;

  private permissionResolvers = new Map<number, (choice: PermissionChoice) => void>();
  private permissionId = 0;
  private alwaysAllowed: Set<string>;

  constructor(private context: vscode.ExtensionContext) {
    this.sessions = new SessionManager(this.ladder()[0]);
    this.alwaysAllowed = new Set(context.workspaceState.get<string[]>(ALLOWED_STORE_KEY, []));
    this.log = vscode.window.createOutputChannel('Claude Coder');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'claudeCoder.showCosts';
    this.updateStatusBar();
    this.statusBar.show();
  }

  attachUi(ui: UiSink): void {
    this.ui = ui;
    this.postSessionInfo();
  }

  private config() {
    return vscode.workspace.getConfiguration('claudeCoder');
  }

  private ladder(): string[] {
    return this.config().get<string[]>('modelLadder') ?? ['claude-sonnet-5'];
  }

  private post(message: Record<string, unknown>): void {
    this.ui?.post(message);
  }

  // ---------- API key ----------

  async setApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      prompt: 'Anthropic API key (stored in VS Code secret storage)',
      password: true,
      ignoreFocusOut: true,
    });
    if (key) {
      await this.context.secrets.store('claudeCoder.apiKey', key.trim());
      this.client = undefined;
      vscode.window.showInformationMessage('Claude Coder: API key saved.');
    }
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) {
      return this.client;
    }
    const stored = await this.context.secrets.get('claudeCoder.apiKey');
    const key = stored || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('No API key. Run "Claude Coder: Set API Key" or export ANTHROPIC_API_KEY.');
    }
    this.client = new Anthropic({ apiKey: key });
    return this.client;
  }

  // ---------- permissions (rendered in the chat, not modal dialogs) ----------

  private async requestPermission(req: PermissionRequest): Promise<boolean> {
    if (req.kind === 'command' && this.config().get<boolean>('autoApproveCommands')) {
      return true;
    }
    if (this.alwaysAllowed.has(req.key)) {
      return true;
    }
    const id = ++this.permissionId;
    const choicePromise = new Promise<PermissionChoice>((resolve) => {
      this.permissionResolvers.set(id, resolve);
    });
    this.post({ type: 'permission', id, title: req.title, detail: req.detail });
    const choice = await choicePromise;
    this.permissionResolvers.delete(id);
    this.post({ type: 'permissionResolved', id, choice });
    if (choice === 'always') {
      this.alwaysAllowed.add(req.key);
      await this.context.workspaceState.update(ALLOWED_STORE_KEY, [...this.alwaysAllowed]);
      this.log.appendLine(`[perm] always-allow "${req.key}"`);
      return true;
    }
    this.log.appendLine(`[perm] ${choice} "${req.key}"`);
    return choice === 'yes';
  }

  handlePermissionResponse(id: number, choice: string): void {
    const resolver = this.permissionResolvers.get(Number(id));
    if (resolver) {
      const c: PermissionChoice = choice === 'always' ? 'always' : choice === 'yes' ? 'yes' : 'no';
      resolver(c);
    }
  }

  async resetPermissions(): Promise<void> {
    this.alwaysAllowed.clear();
    await this.context.workspaceState.update(ALLOWED_STORE_KEY, []);
    vscode.window.showInformationMessage('Claude Coder: all "always allow" permissions cleared.');
  }

  // ---------- main entry: user sent a prompt ----------

  async handleUserMessage(text: string): Promise<void> {
    if (this.busy) {
      this.post({ type: 'notice', text: 'Still working — cancel first or wait.' });
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    try {
      const client = await this.getClient();
      const session = await this.routePrompt(client, text);

      // First message of a session carries the dynamic context the frozen
      // system prompt must not contain (cache discipline).
      let content = text;
      if (session.messages.length === 0) {
        content = this.buildFirstMessagePreamble(session.carryOver) + text;
      }

      const toolCtx = this.buildToolContext();
      const maxTokens = this.config().get<number>('maxTokens') ?? 32000;

      const result = await runTurn(client, session, content, toolCtx, maxTokens, {
        onText: (delta) => this.post({ type: 'delta', text: delta }),
        onToolUse: (name, input) =>
          this.post({ type: 'toolUse', name, detail: previewInput(name, input) }),
        onToolResult: (name, ok, preview) => this.post({ type: 'toolResult', name, ok, preview }),
        onRequestDone: (usage) => {
          this.log.appendLine(
            `[req] session=#${session.id} model=${session.model} ` +
              `in=${usage.input_tokens} out=${usage.output_tokens} ` +
              `cacheRead=${usage.cache_read_input_tokens ?? 0} cacheWrite=${usage.cache_creation_input_tokens ?? 0} ` +
              `sessionCost=${formatUsd(session.cost)} total=${formatUsd(this.grandTotal())}`
          );
          this.updateStatusBar();
          this.postSessionInfo();
        },
        onNotice: (msg) => this.post({ type: 'notice', text: msg }),
      }, this.abort.signal);

      this.post({ type: 'turnDone', stopReason: result.stopReason });
      this.postSessionInfo();
      this.warnIfContextLarge(session.lastInputTokens);
    } catch (e: any) {
      if (e?.message === 'cancelled' || e?.name === 'AbortError') {
        this.post({ type: 'notice', text: 'Cancelled.' });
        this.post({ type: 'turnDone', stopReason: 'cancelled' });
      } else {
        this.log.appendLine(`[error] ${e?.stack ?? e}`);
        this.post({ type: 'error', text: describeError(e) });
        this.post({ type: 'turnDone', stopReason: 'error' });
      }
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.updateStatusBar();
    }
  }

  cancel(): void {
    // Deny any pending permission cards so the loop can unwind, then abort.
    for (const resolver of this.permissionResolvers.values()) {
      resolver('no');
    }
    this.permissionResolvers.clear();
    this.abort?.abort();
  }

  // ---------- routing: task detection + complexity ----------

  private async routePrompt(client: Anthropic, text: string) {
    const autoDetect = this.config().get<boolean>('autoTaskDetection') ?? true;
    const session = this.sessions.current;

    if (!autoDetect) {
      return session;
    }

    try {
      const c = await classifyPrompt(client, session.taskSummary, text, this.classifierTotals);
      if (c.task === 'new' && session.turns > 0) {
        const fresh = this.sessions.reset(this.ladder()[0], EFFORT_BY_COMPLEXITY[c.complexity]);
        fresh.taskSummary = c.summary;
        this.post({
          type: 'taskSwitch',
          text: `New task detected — fresh session started (${displayName(fresh.model)}, effort ${fresh.effort}). Previous session archived.`,
        });
        return fresh;
      }
      if (session.turns === 0) {
        session.taskSummary = c.summary;
        session.effort = EFFORT_BY_COMPLEXITY[c.complexity];
      }
      return session;
    } catch (e: any) {
      // Classifier failure must never block the user; log and fall through.
      this.log.appendLine(`[classifier error] ${e?.message ?? e}`);
      return session;
    }
  }

  // ---------- commands ----------

  newTask(): void {
    this.cancel();
    this.sessions.reset(this.ladder()[0]);
    this.post({ type: 'taskSwitch', text: 'New session started.' });
    this.postSessionInfo();
    this.updateStatusBar();
  }

  async escalate(): Promise<void> {
    const ladder = this.ladder();
    const idx = ladder.indexOf(this.sessions.current.model);
    const next = ladder[idx + 1];
    if (!next) {
      this.post({
        type: 'notice',
        text: `Already on the top model of the ladder (${displayName(this.sessions.current.model)}).`,
      });
      this.post({ type: 'turnDone', stopReason: 'noop' });
      return;
    }
    if (next === 'claude-fable-5') {
      const ok = await this.requestPermission({
        kind: 'command',
        key: `escalate:never-stored:${++this.permissionId}`,
        title: 'Escalate to Fable 5?',
        detail: 'Fable costs 2x Opus ($10 in / $50 out per MTok).',
      });
      if (!ok) {
        this.post({ type: 'turnDone', stopReason: 'noop' });
        return;
      }
    }
    this.cancel();
    const carryOver = this.sessions.buildEscalationCarryOver();
    const summary = this.sessions.current.taskSummary;
    const fresh = this.sessions.reset(next, 'xhigh', carryOver);
    fresh.taskSummary = summary;
    this.post({
      type: 'taskSwitch',
      text: `Escalated to ${displayName(next)} (effort xhigh). The task restarts fresh with a summary of the previous attempt.`,
    });
    this.postSessionInfo();
    this.updateStatusBar();
    await this.handleUserMessage(
      'Continue the task described above. Take a fresh approach informed by what the previous attempt got wrong.'
    );
  }

  showCosts(): void {
    const s = this.sessions.current;
    const classifierCost = costUsd(this.classifierTotals, CLASSIFIER_MODEL);
    const lines = [
      `Current session (#${s.id}, ${displayName(s.model)}, effort ${s.effort}): ${formatUsd(s.cost)}`,
      `  input ${s.totals.inputTokens.toLocaleString()} | output ${s.totals.outputTokens.toLocaleString()} | cache read ${s.totals.cacheReadTokens.toLocaleString()} | cache write ${s.totals.cacheWriteTokens.toLocaleString()}`,
      `  cache hit rate: ${cacheHitRate(s.totals)}`,
      `Task classifier (Haiku): ${formatUsd(classifierCost)}`,
      `All sessions this window: ${formatUsd(this.grandTotal())} across ${this.sessions.totalRequests + this.classifierTotals.requests} requests`,
      '',
      'Per-request detail is in Output → "Claude Coder".',
    ];
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
  }

  // ---------- helpers ----------

  private grandTotal(): number {
    return this.sessions.totalCost + costUsd(this.classifierTotals, CLASSIFIER_MODEL);
  }

  private buildFirstMessagePreamble(carryOver: string | undefined): string {
    const root = this.workspaceRoot();
    const openFiles = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : null))
      .filter(Boolean)
      .slice(0, 15);
    const parts = [
      `<context>`,
      `Workspace root: ${root}`,
      openFiles.length ? `Open editor tabs: ${openFiles.join(', ')}` : '',
      `</context>`,
      carryOver ? `<previous-attempt>\n${carryOver}\n</previous-attempt>` : '',
      '',
    ];
    return parts.filter(Boolean).join('\n') + '\n';
  }

  private buildToolContext(): ToolContext {
    return {
      workspaceRoot: this.workspaceRoot(),
      requestPermission: (req) => this.requestPermission(req),
    };
  }

  private workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a folder first — Claude Coder needs a workspace.');
    }
    return folder.uri.fsPath;
  }

  private warnIfContextLarge(inputTokens: number): void {
    const threshold = this.config().get<number>('compactionThresholdTokens') ?? 100000;
    if (inputTokens > threshold) {
      this.post({
        type: 'notice',
        text: `Context is now ~${Math.round(inputTokens / 1000)}k tokens. Consider "New Task" to reset — long sessions get expensive.`,
      });
    }
  }

  private postSessionInfo(): void {
    const s = this.sessions.current;
    this.post({
      type: 'sessionInfo',
      model: displayName(s.model),
      effort: s.effort,
      cost: formatUsd(s.cost),
      totalCost: formatUsd(this.grandTotal()),
      task: s.taskSummary,
    });
  }

  private updateStatusBar(): void {
    const s = this.sessions.current;
    const spin = this.busy ? '$(sync~spin) ' : '$(sparkle) ';
    this.statusBar.text = `${spin}${displayName(s.model)} · ${formatUsd(this.grandTotal())}`;
    this.statusBar.tooltip = `Claude Coder — session ${formatUsd(s.cost)}, total ${formatUsd(this.grandTotal())}. Click for details.`;
  }

  dispose(): void {
    this.cancel();
    this.statusBar.dispose();
    this.log.dispose();
  }
}

function cacheHitRate(t: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): string {
  const total = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (total === 0) {
    return 'n/a';
  }
  return `${Math.round((t.cacheReadTokens / total) * 100)}%`;
}

function previewInput(name: string, input: any): string {
  try {
    if (input?.path) {
      return String(input.path);
    }
    if (input?.pattern) {
      return String(input.pattern);
    }
    if (input?.command) {
      return String(input.command).slice(0, 120);
    }
    return JSON.stringify(input).slice(0, 120);
  } catch {
    return '';
  }
}

function describeError(e: any): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return 'Invalid API key. Run "Claude Coder: Set API Key".';
  }
  if (e instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the API. Wait a moment and retry.';
  }
  if (e instanceof Anthropic.APIError) {
    return `API error ${e.status ?? ''}: ${e.message}`;
  }
  return e?.message ?? String(e);
}
