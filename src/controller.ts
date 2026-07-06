import * as vscode from 'vscode';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { Session, SessionManager } from './agent/session';
import { runTurn } from './agent/loop';
import { classifyPrompt } from './agent/classifier';
import { planTask } from './agent/planner';
import { compressPrompt } from './agent/compressor';
import { compactTranscript } from './agent/compactor';
import { PermissionRequest, ToolContext } from './agent/tools';
import { MemoryStore } from './agent/memory';
import { runSubscriptionTurn, SubscriptionTurnResult } from './agent/sdkBackend';
import { UsageStore, UsageRecord } from './agent/usageStore';
import { UsagePanel } from './usage/panel';
import {
  CLASSIFIER_MODEL,
  Complexity,
  EFFORT_BY_COMPLEXITY,
  UsageTotals,
  addUsage,
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
  /** Running USD cost of planning calls — kept as a plain sum, not UsageTotals,
   *  because the planning model (Opus vs Fable) can differ call to call. */
  private plannerCost = 0;
  private plannerRequests = 0;
  /** Subscription (Agent SDK) usage — informational: billed to the user's
   *  Pro/Max plan, not to API credits. estValue is API-equivalent USD. */
  private subTotals: UsageTotals = emptyTotals();
  private subValueUsd = 0;
  private abort: AbortController | undefined;
  private ui: UiSink | undefined;
  private statusBar: vscode.StatusBarItem;
  private log: vscode.OutputChannel;
  private busy = false;

  private permissionResolvers = new Map<number, (choice: PermissionChoice) => void>();
  private permissionId = 0;
  private alwaysAllowed: Set<string>;
  private memory: MemoryStore | undefined;
  /** Persistent, cross-workspace usage/billing history — see usageStore.ts. */
  private usageStore: UsageStore | undefined;
  private readonly usageStoreReady: Promise<UsageStore>;

  constructor(private context: vscode.ExtensionContext) {
    this.sessions = new SessionManager(this.ladder()[0]);
    this.sessions.current.backend = this.defaultBackend();
    this.alwaysAllowed = new Set(context.workspaceState.get<string[]>(ALLOWED_STORE_KEY, []));
    this.log = vscode.window.createOutputChannel('Claude Coder');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'claudeCoder.showCosts';
    this.updateStatusBar();
    this.statusBar.show();
    this.usageStoreReady = this.initUsageStore();
  }

  private async initUsageStore(): Promise<UsageStore> {
    const dir = this.context.globalStorageUri.fsPath;
    const store = await UsageStore.load(path.join(dir, 'usage-history.json'));
    this.usageStore = store;
    return store;
  }

  /** Best-effort: a disk hiccup here must never interrupt an in-flight turn. */
  private recordUsage(entry: Omit<UsageRecord, 'timestamp'>): void {
    this.usageStore?.record(entry);
  }

  private snapshotTotals(t: UsageTotals): UsageTotals {
    return { ...t };
  }

  private deltaTotals(before: UsageTotals, after: UsageTotals): UsageTotals {
    return {
      inputTokens: after.inputTokens - before.inputTokens,
      outputTokens: after.outputTokens - before.outputTokens,
      cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
      cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
      requests: after.requests - before.requests,
    };
  }

  async showUsageHistory(): Promise<void> {
    const store = await this.usageStoreReady;
    UsagePanel.show(store);
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

  private planningEnabled(): boolean {
    return this.config().get<boolean>('planningEnabled') ?? true;
  }

  private planningModelLadder(): string[] {
    return this.config().get<string[]>('planningModelLadder') ?? ['claude-opus-4-8', 'claude-fable-5'];
  }

  private planningMaxTokens(): number {
    return this.config().get<number>('planningMaxTokens') ?? 1024;
  }

  private compressLongPrompts(): boolean {
    return this.config().get<boolean>('compressLongPrompts') ?? false;
  }

  private compressionThresholdChars(): number {
    return this.config().get<number>('compressionThresholdChars') ?? 4000;
  }

  private autoCompact(): boolean {
    return this.config().get<boolean>('autoCompact') ?? true;
  }

  private compactionMaxTokens(): number {
    return this.config().get<number>('compactionMaxTokens') ?? 800;
  }

  private minimizeOutputTokens(): boolean {
    return this.config().get<boolean>('minimizeOutputTokens') ?? false;
  }

  private useSubscription(): boolean {
    return this.config().get<boolean>('useSubscription') ?? true;
  }

  private subscriptionModel(): string {
    return this.config().get<string>('subscriptionModel') ?? 'sonnet';
  }

  private defaultBackend(): Session['backend'] {
    return this.useSubscription() ? 'subscription' : 'credits';
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
      const memory = await this.ensureMemory();

      // Long, prose-heavy prompts (pasted logs, specs) get shrunk by Haiku
      // before they ever reach the expensive model. Opt-in: this rewrites
      // the user's own words, so it's off by default.
      if (this.compressLongPrompts() && text.length > this.compressionThresholdChars()) {
        try {
          const before = this.snapshotTotals(this.classifierTotals);
          const { text: compressed, usage } = await compressPrompt(
            client,
            CLASSIFIER_MODEL,
            text,
            Math.min(2000, Math.ceil(this.compressionThresholdChars() / 2))
          );
          addUsage(this.classifierTotals, usage);
          const delta = this.deltaTotals(before, this.classifierTotals);
          this.recordUsage({
            model: CLASSIFIER_MODEL,
            backend: 'credits',
            kind: 'compress',
            sessionId: this.sessions.current.id,
            inputTokens: delta.inputTokens,
            outputTokens: delta.outputTokens,
            cacheReadTokens: delta.cacheReadTokens,
            cacheWriteTokens: delta.cacheWriteTokens,
            costUsd: costUsd(delta, CLASSIFIER_MODEL),
          });
          if (compressed && compressed.length < text.length * 0.9) {
            this.post({ type: 'notice', text: `Compressed a long prompt (${text.length} → ${compressed.length} chars) before sending.` });
            text = compressed;
          }
        } catch (e: any) {
          this.log.appendLine(`[compress error] ${e?.message ?? e}`);
        }
      }

      const session = await this.routePrompt(client, text);

      // First message of a session carries the dynamic context the frozen
      // system prompt must not contain (cache discipline). The plan drafted
      // on the credits reasoning tier feeds forward here — into either backend.
      const isFirst =
        session.backend === 'subscription' ? session.promptCount === 0 : session.messages.length === 0;
      session.promptCount += 1;
      let content = text;
      if (isFirst) {
        content = this.buildFirstMessagePreamble(session.carryOver, memory, session.plan) + text;
      }

      const minimize = this.minimizeOutputTokens();
      if (minimize) {
        // Effort drives how much the model reasons/writes — clamp it to the
        // floor everywhere (including escalations) when minimizing output.
        session.effort = 'low';
      }

      // ---- subscription backend (Agent SDK, billed to the user's plan) ----
      if (session.backend === 'subscription') {
        try {
          const result = await this.runSubscription(session, content, minimize);
          this.post({ type: 'turnDone', stopReason: result.isError ? 'error' : 'end_turn' });
          this.postSessionInfo();
          if (result.isError) {
            this.post({
              type: 'notice',
              text: `Subscription run ended with an error (${result.errorText ?? 'unknown'}).`,
            });
            void this.offerEscalation(
              `The subscription attempt failed (${result.errorText ?? 'unknown'}). Escalating restarts the task on ${displayName(this.ladder()[1] ?? this.ladder()[0])} using API credits.`
            );
          }
          return;
        } catch (e: any) {
          if (e?.message === 'cancelled' || e?.name === 'AbortError' || this.abort?.signal.aborted) {
            throw e;
          }
          // Typical cause: no Claude Code login for the subscription. Fall
          // back to credits for this task instead of failing the prompt.
          this.log.appendLine(`[sub error] ${e?.stack ?? e}`);
          this.post({
            type: 'notice',
            text:
              'Subscription backend unavailable — falling back to API credits for this task. ' +
              'To use your Pro/Max plan, install Claude Code and log in (`claude` → /login), then start a new task.',
          });
          session.backend = 'credits';
        }
      }

      // ---- credits backend (direct API) ----
      const toolCtx = this.buildToolContext(session, memory);
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
          const totals = emptyTotals();
          addUsage(totals, usage);
          this.recordUsage({
            model: session.model,
            backend: 'credits',
            kind: 'turn',
            sessionId: session.id,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            costUsd: costUsd(totals, session.model),
          });
          this.updateStatusBar();
          this.postSessionInfo();
        },
        onNotice: (msg) => this.post({ type: 'notice', text: msg }),
        onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
      }, this.abort.signal, minimize);

      this.post({ type: 'turnDone', stopReason: result.stopReason });
      this.postSessionInfo();
      if (this.autoCompact()) {
        await this.compactIfNeeded(client, session);
      } else {
        this.warnIfContextLarge(session.lastInputTokens);
      }
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

  // ---------- subscription backend ----------

  private async runSubscription(
    session: Session,
    prompt: string,
    minimize: boolean
  ): Promise<SubscriptionTurnResult> {
    const result = await runSubscriptionTurn({
      prompt,
      workspaceRoot: this.workspaceRoot(),
      model: this.subscriptionModel(),
      resumeSessionId: session.sdkSessionId,
      minimizeOutput: minimize,
      maxTurns: 50,
      abort: this.abort!,
      requestPermission: (req) => this.requestPermission(req),
      onText: (delta) => this.post({ type: 'delta', text: delta }),
      onToolUse: (name, detail) => this.post({ type: 'toolUse', name, detail }),
      onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
      onNotice: (msg) => this.post({ type: 'notice', text: msg }),
    });
    session.sdkSessionId = result.sdkSessionId ?? session.sdkSessionId;
    if (result.finalText) {
      session.assistantLog.push(result.finalText);
    }
    this.subTotals.inputTokens += result.usage.inputTokens;
    this.subTotals.outputTokens += result.usage.outputTokens;
    this.subTotals.cacheReadTokens += result.usage.cacheReadTokens;
    this.subTotals.cacheWriteTokens += result.usage.cacheWriteTokens;
    this.subTotals.requests += 1;
    this.subValueUsd += result.estValueUsd;
    this.recordUsage({
      model: this.subscriptionModel(),
      backend: 'subscription',
      kind: 'subscription',
      sessionId: session.id,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costUsd: result.estValueUsd,
    });
    this.log.appendLine(
      `[sub] session=#${session.id} sdk=${result.sdkSessionId ?? '?'} turns=${result.numTurns} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
        `cacheRead=${result.usage.cacheReadTokens} estValue=${formatUsd(result.estValueUsd)} ` +
        `subTotalEst=${formatUsd(this.subValueUsd)}`
    );
    this.updateStatusBar();
    this.postSessionInfo();
    return result;
  }

  /** Chat card asking whether to restart the task on the credits tier. */
  private async offerEscalation(reason: string): Promise<void> {
    const ok = await this.requestPermission({
      kind: 'command',
      key: `escalate-offer:${++this.permissionId}`,
      title: 'Escalate to the credits tier?',
      detail: reason,
    });
    if (ok) {
      await this.escalate();
    }
  }

  // ---------- routing: task detection + complexity ----------

  private async routePrompt(client: Anthropic, text: string) {
    const autoDetect = this.config().get<boolean>('autoTaskDetection') ?? true;
    const session = this.sessions.current;

    if (!autoDetect) {
      return session;
    }

    try {
      const before = this.snapshotTotals(this.classifierTotals);
      const c = await classifyPrompt(client, session.taskSummary, text, this.classifierTotals);
      const delta = this.deltaTotals(before, this.classifierTotals);
      this.recordUsage({
        model: CLASSIFIER_MODEL,
        backend: 'credits',
        kind: 'classify',
        sessionId: session.id,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cacheReadTokens: delta.cacheReadTokens,
        cacheWriteTokens: delta.cacheWriteTokens,
        costUsd: costUsd(delta, CLASSIFIER_MODEL),
      });
      if (c.task === 'new' && session.turns > 0) {
        const backend = this.defaultBackend();
        const fresh = this.sessions.reset(
          this.ladder()[0],
          EFFORT_BY_COMPLEXITY[c.complexity],
          undefined,
          backend
        );
        fresh.taskSummary = c.summary;
        // Post the switch the instant the model changes — planning (Opus/Fable)
        // can take several seconds and must not delay this from showing live.
        this.post({
          type: 'taskSwitch',
          text: `New task detected — fresh session started (${this.backendLabel(fresh)}, effort ${fresh.effort}). Previous session archived.`,
        });
        this.postSessionInfo();
        this.updateStatusBar();
        await this.planIfNeeded(client, fresh, c.complexity, text);
        return fresh;
      }
      if (session.turns === 0) {
        session.taskSummary = c.summary;
        session.effort = EFFORT_BY_COMPLEXITY[c.complexity];
        await this.planIfNeeded(client, session, c.complexity, text);
      }
      return session;
    } catch (e: any) {
      // Classifier failure must never block the user; log and fall through.
      this.log.appendLine(`[classifier error] ${e?.message ?? e}`);
      return session;
    }
  }

  /**
   * For non-trivial tasks, get a short plan from the reasoning tier (Opus for
   * standard, Fable for hard) before Sonnet touches a single tool. The plan
   * rides into the session's first message; Sonnet then implements it at
   * low/high effort with thinking off (see supportsAdaptiveThinking) —
   * cheap, mechanical execution instead of a second round of expensive
   * output-token-heavy reasoning.
   */
  private async planIfNeeded(client: Anthropic, session: Session, complexity: Complexity, text: string): Promise<void> {
    if (complexity === 'trivial' || !this.planningEnabled()) {
      return;
    }
    const ladder = this.planningModelLadder();
    const model = complexity === 'hard' ? ladder[1] ?? ladder[0] : ladder[0];
    if (!model) {
      return;
    }
    try {
      const { plan, usage } = await planTask(client, model, session.taskSummary, text, this.planningMaxTokens());
      const totals = emptyTotals();
      addUsage(totals, usage);
      this.plannerCost += costUsd(totals, model);
      this.plannerRequests += 1;
      this.recordUsage({
        model,
        backend: 'credits',
        kind: 'plan',
        sessionId: session.id,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        costUsd: costUsd(totals, model),
      });
      if (plan) {
        session.plan = plan;
        this.post({
          type: 'notice',
          text: `Plan drafted by ${displayName(model)} (${formatUsd(costUsd(totals, model))}):\n${summarizePlan(plan)}`,
        });
      }
    } catch (e: any) {
      // A missed plan must never block the user — Sonnet just implements without one.
      this.log.appendLine(`[planner error] ${e?.message ?? e}`);
    }
  }

  // ---------- commands ----------

  newTask(): void {
    this.cancel();
    this.sessions.reset(this.ladder()[0], undefined, undefined, this.defaultBackend());
    this.post({ type: 'taskSwitch', text: 'New session started.' });
    this.postSessionInfo();
    this.updateStatusBar();
  }

  async escalate(): Promise<void> {
    const ladder = this.ladder();
    let next: string | undefined;
    if (this.sessions.current.backend === 'subscription') {
      // The subscription runs on the ladder's base tier — escalating means
      // moving to the next credits tier (or the base tier on credits if the
      // ladder has a single entry).
      next = ladder[1] ?? ladder[0];
    } else {
      const idx = ladder.indexOf(this.sessions.current.model);
      next = ladder[idx + 1];
    }
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
    const fresh = this.sessions.reset(next, 'xhigh', carryOver, 'credits');
    fresh.taskSummary = summary;
    this.post({
      type: 'taskSwitch',
      text: `Escalated to ${displayName(next)} on API credits (effort xhigh). The task restarts fresh with a summary of the previous attempt.`,
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
      `Haiku utility calls (classify + compress + compact): ${formatUsd(classifierCost)}`,
      `Planning calls (Opus/Fable): ${formatUsd(this.plannerCost)} across ${this.plannerRequests} calls`,
      `Subscription (Pro/Max plan, not billed as credits): ${this.subTotals.requests} runs, est. value ${formatUsd(this.subValueUsd)}`,
      `  sub tokens: in ${this.subTotals.inputTokens.toLocaleString()} | out ${this.subTotals.outputTokens.toLocaleString()} | cache read ${this.subTotals.cacheReadTokens.toLocaleString()}`,
      `API credits spent this window: ${formatUsd(this.grandTotal())} across ${this.sessions.totalRequests + this.classifierTotals.requests + this.plannerRequests} requests`,
      '',
      'Per-request detail is in Output → "Claude Coder".',
    ];
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
  }

  async showMemory(): Promise<void> {
    const memory = await this.ensureMemory();
    const changes = memory.recentChanges(20);
    const lines =
      changes.length === 0
        ? ['No recorded changes yet.']
        : changes.map(
            (c) => `${new Date(c.timestamp).toLocaleString()}  ${c.tool}  ${c.path}  (${c.taskSummary || 'unknown task'})`
          );
    vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
  }

  // ---------- helpers ----------

  private grandTotal(): number {
    return this.sessions.totalCost + costUsd(this.classifierTotals, CLASSIFIER_MODEL) + this.plannerCost;
  }

  private buildFirstMessagePreamble(
    carryOver: string | undefined,
    memory: MemoryStore,
    plan: string | undefined
  ): string {
    const root = this.workspaceRoot();
    const openFiles = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : null))
      .filter(Boolean)
      .slice(0, 15);
    const digest = memory.projectDigest();
    const parts = [
      `<context>`,
      `Workspace root: ${root}`,
      openFiles.length ? `Open editor tabs: ${openFiles.join(', ')}` : '',
      `</context>`,
      digest ? `<memory>\n${digest}\n</memory>` : '',
      plan ? `<plan>\n${plan}\n</plan>\nImplement the plan above. Don't re-derive it — follow it.` : '',
      carryOver ? `<summary-so-far>\n${carryOver}\n</summary-so-far>` : '',
      '',
    ];
    return parts.filter(Boolean).join('\n') + '\n';
  }

  /** Lazily opens (or creates) the per-workspace local memory file. */
  private async ensureMemory(): Promise<MemoryStore> {
    if (!this.memory) {
      const dir = this.context.storageUri?.fsPath ?? path.join(this.workspaceRoot(), '.claudeCoder');
      this.memory = await MemoryStore.load(path.join(dir, 'memory.json'));
    }
    return this.memory;
  }

  private buildToolContext(session: Session, memory: MemoryStore): ToolContext {
    return {
      workspaceRoot: this.workspaceRoot(),
      requestPermission: (req) => this.requestPermission(req),
      memory,
      taskId: String(session.id),
      taskSummary: session.taskSummary,
      readCache: session.readCache,
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

  /**
   * Local stand-in for server-side compaction: once a session's input passes
   * `compactionThresholdTokens`, collapse its transcript into one Haiku-
   * written summary and keep going on the SAME session (same model/effort/
   * cost totals) instead of just nagging the user to reset by hand. This
   * necessarily breaks the prompt cache for one turn (new content), but
   * every turn after that is cheap again instead of resending a huge history.
   */
  private async compactIfNeeded(client: Anthropic, session: Session): Promise<void> {
    const threshold = this.config().get<number>('compactionThresholdTokens') ?? 100000;
    if (session.lastInputTokens <= threshold || session.messages.length === 0) {
      return;
    }
    try {
      const before = session.lastInputTokens;
      const beforeTotals = this.snapshotTotals(this.classifierTotals);
      const { summary, usage } = await compactTranscript(
        client,
        CLASSIFIER_MODEL,
        session.messages,
        this.compactionMaxTokens()
      );
      addUsage(this.classifierTotals, usage);
      const delta = this.deltaTotals(beforeTotals, this.classifierTotals);
      this.recordUsage({
        model: CLASSIFIER_MODEL,
        backend: 'credits',
        kind: 'compact',
        sessionId: session.id,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cacheReadTokens: delta.cacheReadTokens,
        cacheWriteTokens: delta.cacheWriteTokens,
        costUsd: costUsd(delta, CLASSIFIER_MODEL),
      });
      if (!summary) {
        return;
      }
      session.messages = [];
      session.carryOver = summary;
      session.lastInputTokens = 0;
      // The transcript is gone, so "already read earlier in this session"
      // no longer holds — force fresh reads after compaction.
      session.readCache.clear();
      this.post({
        type: 'notice',
        text: `Context compacted (was ~${Math.round(before / 1000)}k tokens) — summary carried forward, transcript reset to save cost.`,
      });
      this.postSessionInfo();
    } catch (e: any) {
      // Compaction failure must never block the user; fall back to the warning.
      this.log.appendLine(`[compact error] ${e?.message ?? e}`);
      this.warnIfContextLarge(session.lastInputTokens);
    }
  }

  private backendLabel(s: Session): string {
    return s.backend === 'subscription'
      ? `${this.subscriptionModel()} on your plan`
      : `${displayName(s.model)} on credits`;
  }

  private postSessionInfo(): void {
    const s = this.sessions.current;
    const costLine =
      s.backend === 'subscription'
        ? `plan ~${formatUsd(this.subValueUsd)} · credits ${formatUsd(this.grandTotal())}`
        : `${formatUsd(s.cost)} (credits total ${formatUsd(this.grandTotal())})`;
    this.post({
      type: 'sessionInfo',
      model: this.backendLabel(s),
      effort: s.effort,
      cost: formatUsd(s.cost),
      totalCost: formatUsd(this.grandTotal()),
      costLine,
      task: s.taskSummary,
    });
  }

  private updateStatusBar(): void {
    const s = this.sessions.current;
    const spin = this.busy ? '$(sync~spin) ' : '$(sparkle) ';
    const label = s.backend === 'subscription' ? `${this.subscriptionModel()} (plan)` : displayName(s.model);
    this.statusBar.text = `${spin}${label} · ${formatUsd(this.grandTotal())}`;
    this.statusBar.tooltip =
      `Claude Coder — credits: session ${formatUsd(s.cost)}, total ${formatUsd(this.grandTotal())}. ` +
      `Subscription: ${this.subTotals.requests} runs, est. value ${formatUsd(this.subValueUsd)}. Click for details.`;
  }

  dispose(): void {
    this.cancel();
    this.statusBar.dispose();
    this.log.dispose();
  }
}

/** Terse preview of a drafted plan: first couple of bullets, capped in length. */
function summarizePlan(plan: string, maxLines = 3, maxChars = 220): string {
  const lines = plan
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  const summary = lines.join('\n');
  return summary.length > maxChars ? summary.slice(0, maxChars).trimEnd() + '…' : summary;
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
