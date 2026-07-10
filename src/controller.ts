import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Anthropic from '@anthropic-ai/sdk';
import { Session, SessionManager } from './agent/session';
import { runTurn } from './agent/loop';
import { classifyPrompt } from './agent/classifier';
import { planTask } from './agent/planner';
import { compressPrompt } from './agent/compressor';
import { compactTranscript } from './agent/compactor';
import { PermissionRequest, ToolContext } from './agent/tools';
import { MemoryStore } from './agent/memory';
import { runSubscriptionTurn, SubscriptionTurnResult, HaikuTaskResult } from './agent/sdkBackend';
import { resetCliCache } from './agent/cliLocator';
import {
  creditsReady,
  describeSetupGap,
  detectSetup,
  promptAndStoreApiKey,
  runSetupWizard,
  subscriptionReady,
} from './setup';
import { UsageStore, UsageRecord, UsageKind } from './agent/usageStore';
import { UsagePanel } from './usage/panel';
import { ChatHistoryStore } from './agent/chatHistoryStore';
import { ProjectStore } from './agent/projectStore';
import { SummaryStore, SummaryRecord } from './agent/summaryStore';
import { summarizeSession, findRelevantChats, summarizeCommitMessage, summarizeFile } from './agent/summarizer';
import { ChatHistoryPanel } from './history/panel';
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

const execFileAsync = promisify(execFile);

type PermissionChoice = 'yes' | 'always' | 'no';

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
  /** Virtual document content for diff-preview URIs (scheme `claude-coder-diff`), keyed by uri.toString(). */
  private diffVirtualContent = new Map<string, string>();
  private memory: MemoryStore | undefined;
  /** Persistent, cross-workspace usage/billing history — see usageStore.ts. */
  private usageStore: UsageStore | undefined;
  private readonly usageStoreReady: Promise<UsageStore>;
  /** Persistent, cross-workspace chat history (cost/length/duration per chat) — see chatHistoryStore.ts. */
  private chatHistoryStore: ChatHistoryStore | undefined;
  private readonly chatHistoryStoreReady: Promise<ChatHistoryStore>;
  /** Persistent, cross-workspace registry of projects Claude Coder has run in — see projectStore.ts. */
  private projectStore: ProjectStore | undefined;
  private readonly projectStoreReady: Promise<ProjectStore>;
  /** Persistent, cross-workspace end-of-task chat summaries — see summaryStore.ts / summarizer.ts. */
  private summaryStore: SummaryStore | undefined;
  private readonly summaryStoreReady: Promise<SummaryStore>;

  constructor(private context: vscode.ExtensionContext) {
    this.sessions = new SessionManager(this.ladder()[0]);
    this.sessions.current.backend = this.defaultBackend();
    this.log = vscode.window.createOutputChannel('Claude Coder');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'claudeCoder.showCosts';
    this.updateStatusBar();
    this.statusBar.show();
    this.usageStoreReady = this.initUsageStore();
    this.chatHistoryStoreReady = this.initChatHistoryStore();
    this.projectStoreReady = this.initProjectStore();
    this.summaryStoreReady = this.initSummaryStore();
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('claude-coder-diff', {
        provideTextDocumentContent: (uri) => this.diffVirtualContent.get(uri.toString()) ?? '',
      })
    );
  }

  private async initUsageStore(): Promise<UsageStore> {
    const dir = this.context.globalStorageUri.fsPath;
    const store = await UsageStore.load(path.join(dir, 'usage-history.json'));
    this.usageStore = store;
    return store;
  }

  private async initChatHistoryStore(): Promise<ChatHistoryStore> {
    const dir = this.context.globalStorageUri.fsPath;
    const store = await ChatHistoryStore.load(path.join(dir, 'chat-history.json'));
    this.chatHistoryStore = store;
    return store;
  }

  private async initProjectStore(): Promise<ProjectStore> {
    const dir = this.context.globalStorageUri.fsPath;
    const store = await ProjectStore.load(path.join(dir, 'projects.json'));
    this.projectStore = store;
    return store;
  }

  private async initSummaryStore(): Promise<SummaryStore> {
    const dir = this.context.globalStorageUri.fsPath;
    const store = await SummaryStore.load(path.join(dir, 'chat-summaries.json'));
    this.summaryStore = store;
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

  async showChatHistory(): Promise<void> {
    const store = await this.chatHistoryStoreReady;
    const summaries = await this.summaryStoreReady;
    ChatHistoryPanel.show(store, summaries, this.tryWorkspaceRoot());
  }

  attachUi(ui: UiSink): void {
    this.ui = ui;
    this.postSessionInfo();
    void this.offerSetupIfNeeded();
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

  private planningExploration(): boolean {
    return this.config().get<boolean>('planningExploration') ?? true;
  }

  private planningMaxToolCalls(): number {
    return this.config().get<number>('planningMaxToolCalls') ?? 8;
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

  // ---------- setup & API key ----------

  async setApiKey(): Promise<void> {
    if (await promptAndStoreApiKey(this.context)) {
      this.client = undefined;
    }
  }

  /** Walk the user through subscription/API-key setup, then refresh caches. */
  async runSetup(): Promise<void> {
    const summary = await runSetupWizard(this.context);
    if (!summary) {
      this.post({ type: 'notice', text: 'Setup cancelled — rerun it any time with /setup or "Claude Coder: Setup".' });
      return;
    }
    this.client = undefined;
    resetCliCache();
    if (!this.busy) {
      this.sessions.current.backend = this.defaultBackend();
    }
    this.post({ type: 'notice', text: summary });
    this.postSessionInfo();
    this.updateStatusBar();
  }

  /** Chat card that opens the setup wizard. */
  private postSetupCard(title: string, detail: string): void {
    this.post({ type: 'setupNeeded', title, detail });
  }

  /** On first open (or after a broken config) greet the user with the wizard. */
  private async offerSetupIfNeeded(): Promise<void> {
    try {
      const state = await detectSetup(this.context);
      const ready = this.useSubscription()
        ? subscriptionReady(state) || creditsReady(state)
        : creditsReady(state);
      if (!ready) {
        this.postSetupCard(
          'Welcome to Claude Coder — finish setting up',
          `${describeSetupGap(state)}\n\nRun the setup to use your Claude Pro/Max subscription or an Anthropic API key.`
        );
      }
    } catch (e: any) {
      this.log.appendLine(`[setup detect error] ${e?.message ?? e}`);
    }
  }

  /** The API client, or undefined when no key is configured (subscription-only). */
  private async tryGetClient(): Promise<Anthropic | undefined> {
    if (this.client) {
      return this.client;
    }
    const stored = await this.context.secrets.get('claudeCoder.apiKey');
    const key = stored || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return undefined;
    }
    this.client = new Anthropic({ apiKey: key });
    return this.client;
  }

  // ---------- permissions (rendered in the chat, not modal dialogs) ----------

  /**
   * "Always allow" grants are scoped to the current chat (Session), not the
   * workspace — a new task, escalation, or task switch starts a fresh
   * Session with no grants, so permissions never leak between chats.
   */
  private async requestPermission(req: PermissionRequest): Promise<boolean> {
    if (req.kind === 'command' && this.config().get<boolean>('autoApproveCommands')) {
      return true;
    }
    const session = this.sessions.current;
    if (session.alwaysAllowed.has(req.key)) {
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
      session.alwaysAllowed.add(req.key);
      this.log.appendLine(`[perm] always-allow "${req.key}" (chat #${session.id})`);
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

  /** Same plumbing as requestPermission, but also opens a native diff editor for the proposed change. */
  private async requestEditApproval(
    req: PermissionRequest,
    before: string,
    after: string,
    filePath: string,
    fileExists: boolean
  ): Promise<boolean> {
    const session = this.sessions.current;
    if (session.alwaysAllowed.has(req.key)) {
      return true;
    }
    const id = ++this.permissionId;
    const choicePromise = new Promise<PermissionChoice>((resolve) => {
      this.permissionResolvers.set(id, resolve);
    });
    const diffFiles = await this.openDiffInEditor(id, req.title, filePath, fileExists, after);
    this.post({ type: 'permission', id, kind: 'diff', title: req.title, detail: req.detail });
    const choice = await choicePromise;
    this.permissionResolvers.delete(id);
    this.post({ type: 'permissionResolved', id, choice });
    await this.closeDiffFiles(diffFiles);
    if (choice === 'always') {
      session.alwaysAllowed.add(req.key);
      this.log.appendLine(`[perm] always-allow "${req.key}" (chat #${session.id})`);
      return true;
    }
    this.log.appendLine(`[perm] ${choice} "${req.key}"`);
    return choice === 'yes';
  }

  /** Same plumbing as requestPermission, but no autoApprove/alwaysAllowed bypass — plan review is never silent. */
  private async requestPlanApproval(plan: string): Promise<boolean> {
    const id = ++this.permissionId;
    const choicePromise = new Promise<PermissionChoice>((resolve) => {
      this.permissionResolvers.set(id, resolve);
    });
    const planFile = await this.openPlanInEditor(plan);
    this.post({ type: 'permission', id, kind: 'plan', title: 'Plan ready — proceed with implementation?', detail: plan });
    const choice = await choicePromise;
    this.permissionResolvers.delete(id);
    this.post({ type: 'permissionResolved', id, choice });
    await this.closePlanFile(planFile, /* keep */ choice !== 'no');
    return choice !== 'no';
  }

  private requirePlanApproval(): boolean {
    return this.config().get<boolean>('requirePlanApproval') ?? true;
  }

  async resetPermissions(): Promise<void> {
    this.sessions.current.alwaysAllowed.clear();
    vscode.window.showInformationMessage('Claude Coder: "always allow" permissions cleared for the current chat.');
  }

  async commitChanges(message: string): Promise<void> {
    const root = this.tryWorkspaceRoot();
    if (!root) {
      this.post({ type: 'notice', text: 'Open a folder first — Claude Coder needs a workspace.' });
      return;
    }
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    } catch {
      this.post({ type: 'notice', text: 'Not a git repository.' });
      return;
    }

    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: root });
    if (!status.trim()) {
      this.post({ type: 'notice', text: 'Nothing to commit — working tree is clean.' });
      return;
    }

    await execFileAsync('git', ['add', '-A'], { cwd: root });
    this.post({ type: 'notice', text: 'Committing changes…' });
    const commitMessage = message.trim() || (await this.summarizedCommitMessage(root));

    try {
      await execFileAsync('git', ['commit', '-m', commitMessage], { cwd: root });
      this.post({ type: 'notice', text: `Committed: ${commitMessage}` });
    } catch (e) {
      this.post({ type: 'notice', text: `Commit failed: ${describeError(e)}` });
    }
  }

  /**
   * Default commit message when the user didn't supply one: a cheap Haiku
   * call (subscription-first, credits fallback) summarizes the current chat
   * session's transcript into a commit message. Falls back to a message
   * built from staged file names if neither backend is available or the
   * summary call fails.
   */
  private async summarizedCommitMessage(root: string): Promise<string> {
    const session = this.sessions.current;
    try {
      if (session.turns === 0) {
        return await this.defaultCommitMessage(root);
      }
      const client = await this.tryGetClient();
      const result = await summarizeCommitMessage(client, root, session);
      this.recordHaikuUsage('summarize', session.id, result);
      return result.data || (await this.defaultCommitMessage(root));
    } catch (e: any) {
      this.log.appendLine(`[commit summarize error] ${e?.message ?? e}`);
      return await this.defaultCommitMessage(root);
    }
  }

  /** Falls back to a message built from staged file names when no summary is available. */
  private async defaultCommitMessage(root: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: root });
    const files = stdout.trim().split('\n').filter(Boolean);
    if (files.length === 0) {
      return 'Update files';
    }
    if (files.length <= 3) {
      return `Update ${files.join(', ')}`;
    }
    return `Update ${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
  }

  // ---------- main entry: user sent a prompt ----------

  async handleUserMessage(text: string): Promise<void> {
    if (this.busy) {
      this.post({ type: 'notice', text: 'Still working — cancel first or wait.' });
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    this.post({ type: 'accepted' });
    try {
      const memory = await this.ensureMemory();
      const client = await this.tryGetClient();

      // Without an API key the extension can still run subscription tasks —
      // only the credits backend and the Haiku/Opus utility calls need one.
      if (!client && this.sessions.current.backend !== 'subscription') {
        this.postSetupCard(
          'Claude Coder needs setup',
          'No Anthropic API key is configured and the subscription backend is turned off, so there is nothing to run this task on.'
        );
        this.post({ type: 'turnDone', stopReason: 'error' });
        return;
      }

      // Long, prose-heavy prompts (pasted logs, specs) get shrunk by Haiku
      // before they ever reach the expensive model. Opt-in: this rewrites
      // the user's own words, so it's off by default.
      if (client && this.compressLongPrompts() && text.length > this.compressionThresholdChars()) {
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

      // Routing/classification runs on Haiku via credits; without a key we
      // just keep the current session going as-is.
      const { session, planApproved } = client
        ? await this.routePrompt(client, text)
        : { session: this.sessions.current, planApproved: true };
      this.ensureChatRecord(session, text);
      this.chatHistoryStore?.recordPrompt(session.id, text.length);

      if (!planApproved) {
        this.post({ type: 'turnDone', stopReason: 'cancelled' });
        return;
      }

      // First message of a session carries the dynamic context the frozen
      // system prompt must not contain (cache discipline). The plan drafted
      // on the credits reasoning tier feeds forward here — into either backend.
      const isFirst =
        session.backend === 'subscription' ? session.promptCount === 0 : session.messages.length === 0;
      session.promptCount += 1;
      let content = text;
      if (isFirst) {
        const pastSummaries = await this.findRelevantPastSummaries(client, text);
        content = this.buildFirstMessagePreamble(session.carryOver, memory, session.plan, pastSummaries) + text;
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
          const result = await this.runSubscription(session, content, minimize, memory, client);
          if (result.isError && isUsageLimitOrModelError(result.errorText)) {
            // Subscription usage limit hit or the model isn't available on
            // this plan — fall back to API credits for this turn automatically,
            // no user confirmation needed.
            this.log.appendLine(`[sub usage-limit/model fallback] ${result.errorText}`);
            this.post({
              type: 'notice',
              text: `Subscription limit reached (${result.errorText ?? 'unknown'}) — using API credits for this turn.`,
            });
            session.backend = 'credits';
          } else {
            this.post({ type: 'turnDone', stopReason: result.isError ? 'error' : 'end_turn' });
            this.postSessionInfo();
            if (result.isError) {
              this.post({
                type: 'notice',
                text: `Subscription run ended with an error (${result.errorText ?? 'unknown'}).`,
              });
              if (looksLikeAuthProblem(result.errorText)) {
                // Logged out / expired credentials — send the user to setup
                // instead of offering a paid escalation.
                this.postSetupCard(
                  'Claude Code login problem',
                  `The subscription run failed with: ${result.errorText}\n\nRun the setup to log in to Claude Code again, or switch to API credits.`
                );
              } else if (client) {
                void this.offerEscalation(
                  `The subscription attempt failed (${result.errorText ?? 'unknown'}). Escalating restarts the task on ${displayName(this.ladder()[1] ?? this.ladder()[0])} using API credits.`
                );
              }
            }
            return;
          }
        } catch (e: any) {
          if (e?.message === 'cancelled' || e?.name === 'AbortError' || this.abort?.signal.aborted) {
            throw e;
          }
          if (e?.setupNeeded) {
            // Definite setup problem (CLI missing) — retrying or burning
            // credits won't fix it; open the guided setup instead.
            this.log.appendLine(`[sub setup needed] ${e.message}`);
            this.postSetupCard(
              'Claude subscription not available',
              `${e.message}\n\nRun the setup to install Claude Code and log in, or switch to API credits.`
            );
            this.post({ type: 'turnDone', stopReason: 'error' });
            return;
          }
          // Could be a real setup problem (not logged in) or just a transient
          // connection hiccup. Ask before spending credits instead of
          // silently switching billing.
          this.log.appendLine(`[sub error] ${e?.stack ?? e}`);
          const reason = e?.message ?? String(e);
          const retry = await this.requestPermission({
            kind: 'command',
            key: `sub-unavailable:${++this.permissionId}`,
            title: 'Claude subscription unavailable',
            detail:
              `${reason}\n\nThis may just be a connection hiccup with Claude Code, or it may need attention ` +
              '(install/login). Choose "Yes" to retry the subscription now, or "No" to fall back to API credits for this task.',
          });
          if (retry) {
            try {
              const result = await this.runSubscription(session, content, minimize, memory, client);
              this.post({ type: 'turnDone', stopReason: result.isError ? 'error' : 'end_turn' });
              this.postSessionInfo();
              if (result.isError) {
                this.post({
                  type: 'notice',
                  text: `Subscription run ended with an error (${result.errorText ?? 'unknown'}).`,
                });
              }
              return;
            } catch (e2: any) {
              this.log.appendLine(`[sub retry error] ${e2?.stack ?? e2}`);
              this.post({
                type: 'notice',
                text: `Subscription still unavailable (${e2?.message ?? e2}) — falling back to API credits for this task.`,
              });
            }
          } else {
            this.post({
              type: 'notice',
              text:
                'Falling back to API credits for this task. ' +
                'To use your Pro/Max plan again, run /setup (or "Claude Coder: Setup"), then start a new task.',
            });
          }
          session.backend = 'credits';
        }
      }

      // ---- credits backend (direct API) ----
      if (!client) {
        // We only get here without a client via a subscription fallback —
        // and falling back needs an API key that doesn't exist.
        this.postSetupCard(
          'API key needed to fall back to credits',
          'The subscription run can\'t continue (unavailable or over its limit) and no Anthropic API key is configured to fall back on. Run the setup to fix the subscription login or add a key.'
        );
        this.post({ type: 'turnDone', stopReason: 'error' });
        return;
      }
      const toolCtx = this.buildToolContext(session, memory, client);
      const maxTokens = this.config().get<number>('maxTokens') ?? 32000;

      let assistantCharsThisTurn = 0;
      const result = await runTurn(client, session, content, toolCtx, maxTokens, {
        onText: (delta) => {
          assistantCharsThisTurn += delta.length;
          this.post({ type: 'delta', text: delta });
        },
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
          this.chatHistoryStore?.addUsage(session.id, {
            backend: 'credits',
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            costUsd: costUsd(totals, session.model),
            assistantChars: 0,
          });
          this.updateStatusBar();
          this.postSessionInfo();
        },
        onNotice: (msg) => this.post({ type: 'notice', text: msg }),
        onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
        onThinking: (delta) => this.post({ type: 'thinking', text: delta }),
      }, this.abort.signal, minimize);

      this.chatHistoryStore?.addUsage(session.id, {
        backend: 'credits',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        assistantChars: assistantCharsThisTurn,
      });
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
    minimize: boolean,
    memory: MemoryStore,
    client: Anthropic | undefined
  ): Promise<SubscriptionTurnResult> {
    const result = await runSubscriptionTurn({
      prompt,
      workspaceRoot: this.workspaceRoot(),
      toolCtx: this.buildToolContext(session, memory, client),
      model: this.subscriptionModel(),
      resumeSessionId: session.sdkSessionId,
      minimizeOutput: minimize,
      maxTurns: 100,
      abort: this.abort!,
      requestPermission: (req) => this.requestPermission(req),
      onText: (delta) => this.post({ type: 'delta', text: delta }),
      onToolUse: (name, detail) => this.post({ type: 'toolUse', name, detail }),
      onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
      onNotice: (msg) => this.post({ type: 'notice', text: msg }),
      onThinking: (delta) => this.post({ type: 'thinking', text: delta }),
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
    this.chatHistoryStore?.addUsage(session.id, {
      backend: 'subscription',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      costUsd: result.estValueUsd,
      assistantChars: result.finalText?.length ?? 0,
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

  private async routePrompt(client: Anthropic, text: string): Promise<{ session: Session; planApproved: boolean }> {
    const autoDetect = this.config().get<boolean>('autoTaskDetection') ?? true;
    const session = this.sessions.current;

    if (!autoDetect) {
      return { session, planApproved: true };
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
        void this.archiveChat(session);
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
        const planApproved = await this.planIfNeeded(client, fresh, c.complexity, text);
        return { session: fresh, planApproved };
      }
      if (session.turns === 0) {
        session.taskSummary = c.summary;
        session.effort = EFFORT_BY_COMPLEXITY[c.complexity];
        const planApproved = await this.planIfNeeded(client, session, c.complexity, text);
        return { session, planApproved };
      }
      return { session, planApproved: true };
    } catch (e: any) {
      if (e?.message === 'cancelled' || this.abort?.signal.aborted) {
        throw e;
      }
      // Classifier failure must never block the user; log and fall through.
      this.log.appendLine(`[classifier error] ${e?.message ?? e}`);
      return { session, planApproved: true };
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
  /** Returns false if the user rejected the drafted plan — the caller must abort this turn. */
  private async planIfNeeded(client: Anthropic, session: Session, complexity: Complexity, text: string): Promise<boolean> {
    if (complexity === 'trivial' || !this.planningEnabled()) {
      return true;
    }
    const ladder = this.planningModelLadder();
    const model = complexity === 'hard' ? ladder[1] ?? ladder[0] : ladder[0];
    if (!model) {
      return true;
    }
    try {
      // Let the reasoning tier look at the actual code before planning:
      // read-only exploration through the shared tool executor, so its full
      // reads also seed the lazy summary cache for the cheaper turns after.
      const memory = await this.ensureMemory();
      const plannerCtx = this.planningExploration()
        ? {
            ...this.buildToolContext(session, memory, client),
            // The planner's transcript is discarded after this call — sharing
            // the session's readCache would make the executor "reuse" file
            // contents it never actually received.
            readCache: new Map<string, string>(),
          }
        : undefined;
      this.post({ type: 'working', phase: 'planning', tokens: 0 });
      const { plan, usage, toolCalls } = await planTask(
        client,
        model,
        session.taskSummary,
        text,
        this.planningMaxTokens(),
        {
          toolCtx: plannerCtx,
          maxToolCalls: this.planningMaxToolCalls(),
          context: memory.projectDigest(),
          signal: this.abort?.signal,
          onToolUse: (name, detail) => this.post({ type: 'toolUse', name: `plan:${name}`, detail }),
        }
      );
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
          text: `Plan drafted by ${displayName(model)}${toolCalls ? ` after ${toolCalls} code lookup${toolCalls === 1 ? '' : 's'}` : ''} (${formatUsd(costUsd(totals, model))}):\n${summarizePlan(plan)}`,
        });
        // Escalation continuations (carryOver set) already got an explicit "escalate?" confirmation — don't ask twice.
        if (session.carryOver === undefined && this.requirePlanApproval()) {
          const approved = await this.requestPlanApproval(plan);
          if (!approved) {
            session.plan = undefined;
            this.post({ type: 'notice', text: 'Plan rejected — send new instructions to draft another plan.' });
            return false;
          }
        }
      }
      return true;
    } catch (e: any) {
      if (this.abort?.signal.aborted) {
        throw new Error('cancelled');
      }
      // A missed plan must never block the user — Sonnet just implements without one.
      this.log.appendLine(`[planner error] ${e?.message ?? e}`);
      return true;
    }
  }

  // ---------- commands ----------

  newTask(): void {
    this.cancel();
    void this.archiveChat(this.sessions.current);
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
    const notes = memory.listNotes(20);
    const changes = memory.recentChanges(20);
    const summaries = memory.listSummaries(30);
    const root = this.tryWorkspaceRoot();

    const noteLines = notes.map((n) => `${new Date(n.createdAt).toLocaleString()}  note  ${n.text}`);
    const changeLines = changes.map(
      (c) => `${new Date(c.timestamp).toLocaleString()}  ${c.tool}  ${c.path}  (${c.taskSummary || 'unknown task'})`
    );
    const summaryLines = (
      await Promise.all(
        summaries.map(async (s) => {
          const status = await this.summaryFreshness(root, s);
          if (status === 'deleted') {
            memory.forgetFile(s.path);
            return undefined;
          }
          const firstLine = s.summary?.split('\n').find((l) => l.trim()) ?? '';
          return `${new Date(s.summarizedAt ?? 0).toLocaleString()}  [${status}]  ${s.path}  — ${firstLine}`;
        })
      )
    ).filter((l): l is string => !!l);

    const sections = [
      noteLines.length ? `Notes:\n${noteLines.join('\n')}` : '',
      changeLines.length ? `Recent changes:\n${changeLines.join('\n')}` : '',
      summaryLines.length ? `File summaries (read_file lazy cache):\n${summaryLines.join('\n')}` : '',
    ].filter(Boolean);

    vscode.window.showInformationMessage(
      sections.length === 0 ? 'No project memory yet.' : sections.join('\n\n'),
      { modal: true }
    );
  }

  /** Freshness label for a cached file summary — stats the file, doesn't re-read its content. */
  private async summaryFreshness(root: string | undefined, s: { path: string; mtimeMs?: number; size?: number }): Promise<string> {
    if (!root) {
      return 'unknown';
    }
    const abs = path.isAbsolute(s.path) ? s.path : path.join(root, s.path);
    try {
      const stat = await fs.stat(abs);
      return stat.mtimeMs === s.mtimeMs && stat.size === s.size ? 'fresh' : 'stale';
    } catch {
      return 'deleted';
    }
  }

  /**
   * Opens a drafted plan in a full editor tab (markdown) so it's easier to read than the chat sidebar.
   * Writes the plan to a temp file first and opens *that* (instead of an untitled buffer) so the
   * document is never dirty — closing the tab never prompts the user to save.
   */
  private async openPlanInEditor(plan: string): Promise<{ uri: vscode.Uri; fsPath: string }> {
    const fsPath = path.join(os.tmpdir(), `claude-coder-plan-${Date.now()}-${this.permissionId}.md`);
    await fs.writeFile(fsPath, plan, 'utf8');
    const uri = vscode.Uri.file(fsPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    return { uri, fsPath };
  }

  /** Closes the plan's editor tab and either archives the temp file into history (approved) or deletes it (rejected). */
  private async closePlanFile(planFile: { uri: vscode.Uri; fsPath: string }, keep: boolean): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === planFile.uri.toString()) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
    try {
      if (keep) {
        const historyDir = path.join(this.context.globalStorageUri.fsPath, 'plans');
        await fs.mkdir(historyDir, { recursive: true });
        const dest = path.join(historyDir, path.basename(planFile.fsPath));
        await fs.copyFile(planFile.fsPath, dest);
      }
    } finally {
      await fs.unlink(planFile.fsPath).catch(() => undefined);
    }
  }

  /**
   * Opens a native side-by-side diff editor for a proposed write_file/edit_file change.
   * The "before" side is the real file on disk (like VS Code's own Git diff view) when it
   * already exists; for brand-new files it falls back to a virtual empty document. The
   * "after" side (not yet written) is always a virtual document served by the
   * `claude-coder-diff` content provider registered in the constructor.
   */
  private async openDiffInEditor(
    id: number,
    title: string,
    filePath: string,
    fileExists: boolean,
    after: string
  ): Promise<{ beforeUri: vscode.Uri; afterUri: vscode.Uri }> {
    const basename = path.basename(filePath) || 'file';
    const afterUri = vscode.Uri.parse(`claude-coder-diff:/${id}/after/${basename}`);
    this.diffVirtualContent.set(afterUri.toString(), after);
    const beforeUri = fileExists
      ? vscode.Uri.file(filePath)
      : vscode.Uri.parse(`claude-coder-diff:/${id}/before/${basename}`);
    if (!fileExists) {
      this.diffVirtualContent.set(beforeUri.toString(), '');
    }
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
    return { beforeUri, afterUri };
  }

  /** Closes the diff editor tab and releases its virtual document content. */
  private async closeDiffFiles(diffFiles: { beforeUri: vscode.Uri; afterUri: vscode.Uri }): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.toString() === diffFiles.beforeUri.toString() &&
          tab.input.modified.toString() === diffFiles.afterUri.toString()
        ) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
    this.diffVirtualContent.delete(diffFiles.beforeUri.toString());
    this.diffVirtualContent.delete(diffFiles.afterUri.toString());
  }

  /** Manual, freeform memory note for the current project (see MemoryStore.addNote). */
  async addMemoryNote(text: string): Promise<void> {
    const memory = await this.ensureMemory();
    memory.addNote(text);
    vscode.window.showInformationMessage('Memory note saved for this project.');
  }

  // ---------- helpers ----------

  private grandTotal(): number {
    return this.sessions.totalCost + costUsd(this.classifierTotals, CLASSIFIER_MODEL) + this.plannerCost;
  }

  private buildFirstMessagePreamble(
    carryOver: string | undefined,
    memory: MemoryStore,
    plan: string | undefined,
    pastSummaries: SummaryRecord[]
  ): string {
    const root = this.workspaceRoot();
    const openFiles = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : null))
      .filter(Boolean)
      .slice(0, 15);
    const digest = memory.projectDigest();
    const chatHistory = pastSummaries.length
      ? `Summaries of past chats in this project that look relevant to this task:\n${pastSummaries
          .map(
            (s) =>
              `- ${new Date(s.createdAt).toLocaleDateString()}: ${s.summary}${
                s.highlights.length ? ` (${s.highlights.join('; ')})` : ''
              }`
          )
          .join('\n')}`
      : '';
    const parts = [
      `<context>`,
      `Workspace root: ${root}`,
      openFiles.length ? `Open editor tabs: ${openFiles.join(', ')}` : '',
      `</context>`,
      chatHistory ? `<chat-history>\n${chatHistory}\n</chat-history>` : '',
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

  private buildToolContext(session: Session, memory: MemoryStore, client: Anthropic | undefined): ToolContext {
    return {
      workspaceRoot: this.workspaceRoot(),
      requestPermission: (req) => this.requestPermission(req),
      requestEditApproval: (req, before, after, filePath, fileExists) =>
        this.requestEditApproval(req, before, after, filePath, fileExists),
      memory,
      taskId: String(session.id),
      taskSummary: session.taskSummary,
      readCache: session.readCache,
      // Tries the subscription's Haiku before falling back to credits (see
      // summarizeFileForMemory) — available even for subscription-only users.
      summarizeFile: (path, content) => this.summarizeFileForMemory(client, path, content),
    };
  }

  /**
   * Adds a Haiku-tier background call's usage to the right cost bucket —
   * subscription usage into subTotals/subValueUsd (billed to the Pro/Max
   * plan), credits usage into classifierTotals (billed per-token) — mirroring
   * how the main turn splits between runSubscription and the credits path.
   */
  private recordHaikuUsage(kind: UsageKind, sessionId: number, result: HaikuTaskResult): void {
    if (result.backend === 'subscription') {
      this.subTotals.inputTokens += result.usage.inputTokens;
      this.subTotals.outputTokens += result.usage.outputTokens;
      this.subTotals.cacheReadTokens += result.usage.cacheReadTokens;
      this.subTotals.cacheWriteTokens += result.usage.cacheWriteTokens;
      this.subTotals.requests += 1;
      this.subValueUsd += result.estValueUsd;
      this.recordUsage({
        model: CLASSIFIER_MODEL,
        backend: 'subscription',
        kind,
        sessionId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: result.estValueUsd,
      });
    } else {
      addUsage(this.classifierTotals, {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        cache_read_input_tokens: result.usage.cacheReadTokens,
        cache_creation_input_tokens: result.usage.cacheWriteTokens,
      } as Anthropic.Usage);
      this.recordUsage({
        model: CLASSIFIER_MODEL,
        backend: 'credits',
        kind,
        sessionId,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: costUsd({ ...result.usage, requests: 1 }, CLASSIFIER_MODEL),
      });
    }
  }

  /**
   * Best-effort file digest for the lazy read-file summary cache (see
   * tools.ts readFileTool / memory.ts MemoryStore.saveSummary). Never throws
   * — a missed summary just means the next read falls back to raw content.
   */
  private async summarizeFileForMemory(client: Anthropic | undefined, filePath: string, content: string): Promise<string | undefined> {
    try {
      const result = await summarizeFile(client, this.tryWorkspaceRoot(), filePath, content);
      if (!result) {
        return undefined;
      }
      this.recordHaikuUsage('summarize', this.sessions.current.id, result);
      return result.data;
    } catch (e: any) {
      this.log.appendLine(`[file summarize error] ${e?.message ?? e}`);
      return undefined;
    }
  }

  private workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a folder first — Claude Coder needs a workspace.');
    }
    return folder.uri.fsPath;
  }

  private tryWorkspaceRoot(): string | undefined {
    try {
      return this.workspaceRoot();
    } catch {
      return undefined;
    }
  }

  /** Lazily creates the chat-history record for a session's id (no-op after the first call). */
  private ensureChatRecord(session: Session, promptText: string): void {
    if (!this.chatHistoryStore) {
      return;
    }
    const root = this.tryWorkspaceRoot();
    this.chatHistoryStore.ensure(session.id, {
      projectPath: root ?? 'unknown',
      projectName: root ? path.basename(root) : 'unknown',
      title: (session.taskSummary || promptText).slice(0, 80),
      model: session.backend === 'subscription' ? this.subscriptionModel() : session.model,
      backend: session.backend,
      createdAt: Date.now(),
    });
    if (root) {
      this.projectStore?.ensure(root, path.basename(root));
    }
  }

  /**
   * Best-effort end-of-task summary: a cheap Haiku call turns the finished
   * session's transcript into a durable summary, stored as the chat's
   * "memory" for the project history view. Never blocks or throws — a
   * missed summary must not interrupt the task switch that triggered it.
   */
  private async archiveChat(session: Session): Promise<void> {
    if (!this.summaryStore || session.turns === 0) {
      return;
    }
    try {
      const client = await this.tryGetClient();
      const result = await summarizeSession(client, this.tryWorkspaceRoot(), session);
      this.recordHaikuUsage('summarize', session.id, result);
      this.summaryStore.add({
        chatId: session.id,
        projectPath: this.tryWorkspaceRoot() ?? 'unknown',
        model: CLASSIFIER_MODEL,
        summary: result.data.summary,
        highlights: result.data.highlights,
      });
    } catch (e: any) {
      this.log.appendLine(`[summarize error] ${e?.message ?? e}`);
    }
  }

  /**
   * Best-effort: ask Haiku which past chats in this project (if any) are
   * relevant to the upcoming task, so a new chat reuses the right memories
   * instead of just the most recent ones. Falls back to recency on error.
   */
  private async findRelevantPastSummaries(client: Anthropic | undefined, upcomingTask: string): Promise<SummaryRecord[]> {
    const root = this.tryWorkspaceRoot();
    if (!root || !this.summaryStore) {
      return [];
    }
    const summaries = await this.summaryStoreReady;
    const candidates = summaries.latestForProject(root, 20);
    if (candidates.length === 0) {
      return [];
    }
    try {
      const result = await findRelevantChats(client, root, upcomingTask, candidates);
      this.recordHaikuUsage('recall', this.sessions.current.id, result);
      const byId = new Map(candidates.map((c) => [c.chatId, c]));
      return result.data.map((id) => byId.get(id)).filter((s): s is SummaryRecord => !!s);
    } catch (e: any) {
      this.log.appendLine(`[recall error] ${e?.message ?? e}`);
      return candidates.slice(0, 5);
    }
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
      const result = await compactTranscript(client, this.tryWorkspaceRoot(), session.messages, this.compactionMaxTokens());
      this.recordHaikuUsage('compact', session.id, result);
      const summary = result.summary;
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
/**
 * Detects subscription-side failures that should trigger an automatic,
 * silent fallback to API credits: usage/rate limits and models the current
 * plan can't access. Any other error (auth, bad request, etc.) surfaces
 * normally instead of silently spending credits.
 */
function isUsageLimitOrModelError(errorText: string | undefined): boolean {
  if (!errorText) {
    return false;
  }
  const t = errorText.toLowerCase();
  return (
    /usage limit|rate limit|rate_limit|429|quota|too many requests/.test(t) ||
    /model.{0,20}(not found|not available|not allowed|unsupported|unavailable)/.test(t) ||
    /not_found_error|permission_error|model_not_found/.test(t)
  );
}

/**
 * Subscription-side failures that mean the Claude Code login itself is broken
 * (logged out, expired OAuth) — the fix is the setup wizard, not a retry or
 * an escalation to credits.
 */
function looksLikeAuthProblem(errorText: string | undefined): boolean {
  if (!errorText) {
    return false;
  }
  return /\/login|log ?in|logged out|authentication|unauthorized|401|invalid api key|oauth|credential/i.test(
    errorText
  );
}

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
    return 'Invalid API key. Run /setup (or "Claude Coder: Set API Key") to fix it.';
  }
  if (e instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the API. Wait a moment and retry.';
  }
  if (e instanceof Anthropic.APIError) {
    return `API error ${e.status ?? ''}: ${e.message}`;
  }
  return e?.message ?? String(e);
}
