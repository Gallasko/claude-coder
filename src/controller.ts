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
import { buildRepoMap } from './agent/repoMap';
import { compressPrompt } from './agent/compressor';
import { compactTranscript } from './agent/compactor';
import { PermissionRequest, ToolContext, AskQuestionItem } from './agent/tools';
import { MemoryStore } from './agent/memory';
import { withRetry } from './agent/retry';
import {
  runSubscriptionTurn,
  runSubscriptionPlan,
  fetchSubscriptionRateLimit,
  SubscriptionTurnResult,
  SubscriptionRateLimit,
  HaikuTaskResult,
} from './agent/sdkBackend';
import { resetCliCache } from './agent/cliLocator';
import { BackendPreference, DEFAULT_BACKEND_PREFERENCE, allowsFallback } from './config';
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
import { MessageStore } from './agent/messageStore';
import { TaskMemory, TaskMemoryFile, TaskMemoryStore } from './agent/taskMemoryStore';
import { DeferredTaskStore } from './agent/deferredTaskStore';
import {
  summarizeSession,
  findRelevantChats,
  summarizeCommitMessage,
  summarizeDiff,
  summarizeFile,
  preprocessFileForPlanning,
  createTaskMemory,
  findRelevantMemories,
} from './agent/summarizer';
import { ChatHistoryPanel } from './history/panel';
import { MemoryPanel } from './memory/panel';
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
type PlanDecision = { action: 'approve' | 'reject' | 'escalate' | 'change'; text?: string };

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
  private warnedRateLimitWindows = new Set<string>();
  private abort: AbortController | undefined;
  private uis = new Set<UiSink>();
  private statusBar: vscode.StatusBarItem;
  private log: vscode.OutputChannel;
  private busy = false;
  /** Turn count at the time each session was last archived, so idle/commit/close
   *  triggers don't re-archive a session that hasn't changed since. */
  private lastArchivedTurns = new Map<string, number>();
  private idleSaveTimer: NodeJS.Timeout | undefined;
  private static readonly IDLE_SAVE_DELAY_MS = 2.5 * 60 * 1000;

  private permissionResolvers = new Map<number, (choice: PermissionChoice) => void>();
  private questionResolvers = new Map<number, (answers: Record<string, string>) => void>();
  private planResolvers = new Map<number, (decision: PlanDecision) => void>();
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
  /** Persistent, cross-workspace raw transcript (every user/assistant turn) — see messageStore.ts. */
  private messageStore: MessageStore | undefined;
  private readonly messageStoreReady: Promise<MessageStore>;
  /** Persistent, per-workspace task-level memories (summary + touched files) — see taskMemoryStore.ts. */
  private taskMemory: TaskMemoryStore | undefined;
  /** Persistent, per-workspace tasks deferred until the plan limit resets — see deferredTaskStore.ts. */
  private deferredTasks: DeferredTaskStore | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.sessions = new SessionManager(this.ladder()[0]);
    this.sessions.current.backend = this.defaultBackend();
    this.sessions.current.subModel = this.subscriptionModel();
    this.log = vscode.window.createOutputChannel('Claude Coder');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = 'claudeCoder.showCosts';
    this.updateStatusBar();
    this.statusBar.show();
    this.usageStoreReady = this.initUsageStore();
    this.chatHistoryStoreReady = this.initChatHistoryStore();
    this.projectStoreReady = this.initProjectStore();
    this.summaryStoreReady = this.initSummaryStore();
    this.messageStoreReady = this.initMessageStore();
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

  private async initMessageStore(): Promise<MessageStore> {
    const dir = this.context.globalStorageUri.fsPath;
    const store = await MessageStore.load(path.join(dir, 'chat-messages.json'));
    this.messageStore = store;
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
    const rateLimit = await fetchSubscriptionRateLimit().catch(() => undefined);
    UsagePanel.show(store, rateLimit, () => fetchSubscriptionRateLimit().catch(() => undefined));
  }

  /** Reports claude.ai plan rate-limit utilization (5-hour + weekly windows) for the logged-in Claude Code CLI. */
  async showSubscriptionUsage(): Promise<void> {
    try {
      const { windows } = await fetchSubscriptionRateLimit();
      if (!windows.length) {
        this.post({ type: 'notice', text: 'No plan rate-limit data available — this account may not have plan limits.' });
        return;
      }
      const lines = windows.map((w) => {
        const pct = w.utilization != null ? `${Math.round(w.utilization)}% used` : 'usage unknown';
        const resets = w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : '';
        return `${w.label}: ${pct}${resets}`;
      });
      this.post({ type: 'notice', text: ['Claude subscription plan usage:', ...lines].join('\n') });
    } catch (e: any) {
      if (e?.setupNeeded) {
        this.postSetupCard('Claude subscription not available', `${e.message}\n\nRun the setup to log in, or check with \`claude /usage\` in a terminal.`);
        return;
      }
      this.post({ type: 'notice', text: `Couldn't fetch subscription usage: ${describeError(e)}` });
    }
  }

  async showChatHistory(): Promise<void> {
    const store = await this.chatHistoryStoreReady;
    const summaries = await this.summaryStoreReady;
    const messages = await this.messageStoreReady;
    ChatHistoryPanel.show(store, summaries, messages, this.tryWorkspaceRoot());
  }

  attachUi(ui: UiSink): void {
    const isFirst = this.uis.size === 0;
    this.uis.add(ui);
    this.postSessionInfo();
    if (isFirst) {
      void this.offerSetupIfNeeded();
    }
  }

  detachUi(ui: UiSink): void {
    this.uis.delete(ui);
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
    return this.config().get<number>('planningMaxTokens') ?? 2048;
  }

  private planningExploration(): boolean {
    return this.config().get<boolean>('planningExploration') ?? true;
  }

  private planningMaxToolCalls(): number {
    return this.config().get<number>('planningMaxToolCalls') ?? 8;
  }

  private repoMapTokens(): number {
    return this.config().get<number>('repoMapTokens') ?? 1024;
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

  /** New preference key wins when set; otherwise falls back to the deprecated boolean. */
  private backendPreference(): BackendPreference {
    const configured = this.config().get<BackendPreference>('backendPreference');
    if (configured) {
      return configured;
    }
    return this.config().get<boolean>('useSubscription') === false ? 'apiOnly' : DEFAULT_BACKEND_PREFERENCE;
  }

  private subscriptionModel(): string {
    return this.config().get<string>('subscriptionModel') ?? 'sonnet';
  }

  private rateLimitWarnThreshold(): number {
    return this.config().get<number>('rateLimitWarnThreshold') ?? 80;
  }

  /** Maps a planning-ladder API model id to the subscription CLI's model alias, or undefined if the CLI has no equivalent (e.g. Fable). */
  private subscriptionModelAlias(apiModel: string): string | undefined {
    if (apiModel.startsWith('claude-opus-4')) {
      return 'opus';
    }
    if (apiModel.startsWith('claude-sonnet')) {
      return 'sonnet';
    }
    if (apiModel.startsWith('claude-haiku')) {
      return 'haiku';
    }
    return undefined;
  }

  private defaultBackend(): Session['backend'] {
    const pref = this.backendPreference();
    return pref === 'apiOnly' || pref === 'preferApi' ? 'credits' : 'subscription';
  }

  private post(message: Record<string, unknown>): void {
    for (const ui of this.uis) {
      ui.post(message);
    }
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
      this.sessions.current.subModel = this.subscriptionModel();
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
      const pref = this.backendPreference();
      const ready =
        pref === 'apiOnly'
          ? creditsReady(state)
          : pref === 'subscriptionOnly'
          ? subscriptionReady(state)
          : subscriptionReady(state) || creditsReady(state);
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

  handlePlanResponse(id: number, action: string, text?: string): void {
    const resolver = this.planResolvers.get(Number(id));
    if (resolver) {
      const a: PlanDecision['action'] =
        action === 'approve' || action === 'escalate' || action === 'change' ? action : 'reject';
      resolver(a === 'change' ? { action: a, text } : { action: a });
    }
  }

  /** Puts a clarifying multiple-choice question card in the chat and waits for the user's answers. */
  private async requestQuestion(questions: AskQuestionItem[]): Promise<Record<string, string>> {
    const id = ++this.permissionId;
    const answersPromise = new Promise<Record<string, string>>((resolve) => {
      this.questionResolvers.set(id, resolve);
    });
    this.post({ type: 'askQuestion', id, questions });
    const answers = await answersPromise;
    this.questionResolvers.delete(id);
    this.post({ type: 'askQuestionResolved', id, answers });
    return answers;
  }

  handleAskQuestionResponse(id: number, answers: Record<string, string>): void {
    const resolver = this.questionResolvers.get(Number(id));
    if (resolver) {
      resolver(answers);
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
  private async requestPlanApproval(plan: string): Promise<PlanDecision> {
    const id = ++this.permissionId;
    const decisionPromise = new Promise<PlanDecision>((resolve) => {
      this.planResolvers.set(id, resolve);
    });
    let planFile: { uri: vscode.Uri; fsPath: string };
    try {
      planFile = await withTransientRetry(() => this.openPlanInEditor(plan));
    } catch (e) {
      // Never leave a resolver registered for a card that was never shown —
      // the caller (planIfNeeded) already treats this failure as "proceed
      // without approval," so failing to clean up here would leak this id
      // in planResolvers forever.
      this.planResolvers.delete(id);
      throw e;
    }
    this.post({ type: 'permission', id, kind: 'plan', title: 'Plan ready — proceed with implementation?', detail: plan });
    const decision = await decisionPromise;
    this.planResolvers.delete(id);
    this.post({ type: 'permissionResolved', id, choice: decision.action === 'approve' ? 'yes' : 'no' });
    await this.closePlanFile(planFile, /* keep */ decision.action === 'approve');
    return decision;
  }

  private requirePlanApproval(): boolean {
    return this.config().get<boolean>('requirePlanApproval') ?? true;
  }

  async resetPermissions(): Promise<void> {
    this.sessions.current.alwaysAllowed.clear();
    vscode.window.showInformationMessage('Claude Coder: "always allow" permissions cleared for the current chat.');
  }

  /** Offers a commit prompt after a successful turn if the workspace has uncommitted changes. */
  private async maybePromptCommit(): Promise<void> {
    const root = this.tryWorkspaceRoot();
    if (!root) {
      return;
    }
    if (this.abort?.signal.aborted) {
      return;
    }
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    } catch {
      return;
    }
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: root });
    if (!stdout.trim()) {
      return;
    }
    const question = 'Commit these changes?';
    const answers = await this.requestQuestion([
      {
        question,
        header: 'Commit',
        options: [
          { label: 'Commit', description: 'Stage all and commit with an auto-generated message' },
          { label: 'Not now', description: 'Leave changes uncommitted' },
        ],
        multiSelect: false,
        instant: true,
      },
    ]);
    if (answers[question] === 'Commit') {
      await this.commitChanges('', 'user');
    }
  }

  /** Resolves `-c user.name=… -c user.email=…` overrides for `git commit`, or [] to use ambient git config. */
  private async resolveCommitIdentity(root: string, identity: 'user' | 'claude'): Promise<string[]> {
    if (identity === 'claude') {
      const name = this.config().get<string>('claudeCommitName') || 'Claude';
      const email = this.config().get<string>('claudeCommitEmail') || 'noreply@anthropic.com';
      return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
    }
    let hasName = false;
    let hasEmail = false;
    try {
      await execFileAsync('git', ['config', '--get', 'user.name'], { cwd: root });
      hasName = true;
    } catch {
      // unset
    }
    try {
      await execFileAsync('git', ['config', '--get', 'user.email'], { cwd: root });
      hasEmail = true;
    } catch {
      // unset
    }
    if (hasName && hasEmail) {
      return [];
    }
    const name = this.config().get<string>('commitAuthorName') || '';
    const email = this.config().get<string>('commitAuthorEmail') || '';
    const args: string[] = [];
    if (!hasName && name) {
      args.push('-c', `user.name=${name}`);
    }
    if (!hasEmail && email) {
      args.push('-c', `user.email=${email}`);
    }
    return args;
  }

  async commitChanges(message: string, identity: 'user' | 'claude' = 'user'): Promise<void> {
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
    const trimmed = message.trim();
    const commitMessage = trimmed
      ? [trimmed, await this.summaryBody(root)].filter(Boolean).join('\n\n')
      : await this.summarizedCommitMessage(root);
    const idArgs = await this.resolveCommitIdentity(root, identity);

    try {
      await execFileAsync('git', [...idArgs, 'commit', '-m', commitMessage], { cwd: root });
      this.post({ type: 'notice', text: `Committed: ${commitMessage}` });
      void this.archiveChat(this.sessions.current);
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

  /**
   * Builds a prose/bulleted summary of the staged changes for the commit
   * body. A cheap Haiku call (subscription-first, credits fallback)
   * summarizes the staged diff; falls back to a file-status list if neither
   * backend is available or the summary call fails.
   */
  private async summaryBody(root: string): Promise<string> {
    const { stdout: diff } = await execFileAsync('git', ['diff', '--cached'], { cwd: root });
    if (!diff.trim()) {
      return '';
    }
    try {
      const client = await this.tryGetClient();
      const result = await summarizeDiff(client, root, diff);
      this.recordHaikuUsage('summarize', this.sessions.current.id, result);
      return result.data || (await this.fileStatusBody(root));
    } catch (e: any) {
      this.log.appendLine(`[commit diff summarize error] ${e?.message ?? e}`);
      return await this.fileStatusBody(root);
    }
  }

  /** Falls back to a "resume of modifications" body listing staged files by change status. */
  private async fileStatusBody(root: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-status'], { cwd: root });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return '';
    }
    return lines.map((line) => `- ${line.replace(/\t/g, ' ')}`).join('\n');
  }

  // ---------- main entry: user sent a prompt ----------

  async handleUserMessage(text: string): Promise<void> {
    if (this.busy) {
      this.post({ type: 'notice', text: 'Still working — cancel first or wait.' });
      return;
    }
    this.clearIdleSave();
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

      // Routing/classification runs on Haiku, subscription-first with
      // credits fallback — works for subscription-only users too.
      const { session, planApproved } = await this.routePrompt(client, text);
      this.ensureChatRecord(session, text);
      this.chatHistoryStore?.recordPrompt(session.id, text.length);
      this.messageStore?.add({
        chatId: session.id,
        projectPath: this.tryWorkspaceRoot() ?? 'unknown',
        role: 'user',
        text,
      });

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
        const taskMemories = await this.findRelevantTaskMemories(client, text);
        content = this.buildFirstMessagePreamble(session.carryOver, memory, session.plan, pastSummaries, taskMemories) + text;
      }

      const minimize = this.minimizeOutputTokens();
      if (minimize) {
        // Effort drives how much the model reasons/writes — clamp it to the
        // floor everywhere (including escalations) when minimizing output.
        session.effort = 'low';
      }

      // ---- subscription backend (Agent SDK, billed to the user's plan) ----
      if (session.backend === 'subscription') {
        const preference = this.backendPreference();
        const canFallbackToCredits = allowsFallback(preference) && !!client;
        try {
          const result = await this.runSubscription(session, content, minimize, memory, client);
          if (result.isError && isUsageLimitError(result.errorText)) {
            // Plan usage limit hit — ask instead of silently spending credits:
            // escalate now, defer until the plan resets, or drop the prompt.
            this.log.appendLine(`[sub usage-limit] ${result.errorText}`);
            const action = await this.offerLimitChoice(session, text, result, canFallbackToCredits);
            if (action === 'credits') {
              this.post({ type: 'notice', text: 'Continuing this turn on API credits.' });
              session.backend = 'credits';
              // falls through to the credits backend below
            } else {
              this.post({ type: 'turnDone', stopReason: action === 'cancel' ? 'cancelled' : 'end_turn' });
              this.postSessionInfo();
              if (action === 'escalate-plan') {
                // escalate() re-enters handleUserMessage — let this turn's
                // finally release the busy flag first.
                setTimeout(() => void this.escalate(), 0);
              }
              return;
            }
          } else if (result.isError && isUsageLimitOrModelError(result.errorText) && canFallbackToCredits) {
            // Model isn't available on this plan — fall back to API credits
            // for this turn automatically, no user confirmation needed.
            this.log.appendLine(`[sub model fallback] ${result.errorText}`);
            this.post({
              type: 'notice',
              text: `Subscription can't run this model (${result.errorText ?? 'unknown'}) — using API credits for this turn.`,
            });
            session.backend = 'credits';
          } else {
            this.post({ type: 'turnDone', stopReason: result.isError ? 'error' : 'end_turn' });
            this.postSessionInfo();
            void this.maybeUpdateTaskMemory(session, client);
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
                const currentSubModel = session.subModel ?? this.subscriptionModel();
                const escalateDesc =
                  currentSubModel !== 'opus'
                    ? 'Escalating switches to opus on your subscription plan (no credits spent).'
                    : `Escalating restarts the task on ${displayName(this.ladder()[1] ?? this.ladder()[0])} using API credits.`;
                void this.offerEscalation(`The subscription attempt failed (${result.errorText ?? 'unknown'}). ${escalateDesc}`);
              }
            }
            if (!result.isError) {
              await this.maybePromptCommit();
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
            detail: canFallbackToCredits
              ? `${reason}\n\nThis may just be a connection hiccup with Claude Code, or it may need attention ` +
                '(install/login). Choose "Yes" to retry the subscription now, or "No" to fall back to API credits for this task.'
              : `${reason}\n\nThis may just be a connection hiccup with Claude Code, or it may need attention ` +
                '(install/login). Backend preference is "Subscription only", so this task will not fall back to API credits. Choose "Yes" to retry.',
          });
          if (retry) {
            try {
              const result = await this.runSubscription(session, content, minimize, memory, client);
              this.post({ type: 'turnDone', stopReason: result.isError ? 'error' : 'end_turn' });
              this.postSessionInfo();
              void this.maybeUpdateTaskMemory(session, client);
              if (result.isError) {
                this.post({
                  type: 'notice',
                  text: `Subscription run ended with an error (${result.errorText ?? 'unknown'}).`,
                });
              } else {
                await this.maybePromptCommit();
              }
              return;
            } catch (e2: any) {
              this.log.appendLine(`[sub retry error] ${e2?.stack ?? e2}`);
              if (!canFallbackToCredits) {
                this.post({
                  type: 'notice',
                  text: `Subscription still unavailable (${e2?.message ?? e2}). Backend preference is "Subscription only" — no fallback available.`,
                });
                this.post({ type: 'turnDone', stopReason: 'error' });
                return;
              }
              this.post({
                type: 'notice',
                text: `Subscription still unavailable (${e2?.message ?? e2}) — falling back to API credits for this task.`,
              });
            }
          } else {
            if (!canFallbackToCredits) {
              this.post({ type: 'turnDone', stopReason: 'cancelled' });
              return;
            }
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
      let thinkingBuf = '';
      const result = await runTurn(client, session, content, toolCtx, maxTokens, {
        onText: (delta) => {
          assistantCharsThisTurn += delta.length;
          this.post({ type: 'delta', text: delta });
        },
        onToolUse: (name, input) => {
          const detail = previewInput(name, input);
          this.messageStore?.add({
            chatId: session.id,
            projectPath: this.tryWorkspaceRoot() ?? 'unknown',
            role: 'tool',
            text: `${name} ${detail}`,
          });
          this.post({ type: 'toolUse', name, detail });
        },
        onToolResult: (name, ok, preview) => this.post({ type: 'toolResult', name, ok, preview }),
        onRequestDone: (usage, servedModel) => {
          this.log.appendLine(
            `[req] session=#${session.id} model=${servedModel} ` +
              `in=${usage.input_tokens} out=${usage.output_tokens} ` +
              `cacheRead=${usage.cache_read_input_tokens ?? 0} cacheWrite=${usage.cache_creation_input_tokens ?? 0} ` +
              `sessionCost=${formatUsd(session.cost)} total=${formatUsd(this.grandTotal())}`
          );
          const totals = emptyTotals();
          addUsage(totals, usage);
          this.recordUsage({
            model: servedModel,
            backend: 'credits',
            kind: 'turn',
            sessionId: session.id,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            costUsd: costUsd(totals, servedModel),
          });
          this.chatHistoryStore?.addUsage(session.id, {
            backend: 'credits',
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            costUsd: costUsd(totals, servedModel),
            assistantChars: 0,
          });
          this.updateStatusBar();
          this.postSessionInfo();
        },
        onNotice: (msg) => this.post({ type: 'notice', text: msg }),
        onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
        onThinking: (delta) => {
          thinkingBuf += delta;
          this.post({ type: 'thinking', text: delta });
        },
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
      if (result.finalText) {
        this.messageStore?.add({
          chatId: session.id,
          projectPath: this.tryWorkspaceRoot() ?? 'unknown',
          role: 'assistant',
          text: result.finalText,
        });
      }
      if (thinkingBuf.trim()) {
        this.messageStore?.add({
          chatId: session.id,
          projectPath: this.tryWorkspaceRoot() ?? 'unknown',
          role: 'thinking',
          text: thinkingBuf,
        });
      }
      this.post({ type: 'turnDone', stopReason: result.stopReason });
      this.postSessionInfo();
      void this.maybeUpdateTaskMemory(session, client);
      await this.maybePromptCommit();
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
      this.armIdleSave(this.sessions.current);
    }
  }

  cancel(): void {
    // Deny any pending permission cards so the loop can unwind, then abort.
    for (const resolver of this.permissionResolvers.values()) {
      resolver('no');
    }
    this.permissionResolvers.clear();
    // Same for pending question cards — an unresolved ask_question keeps the
    // tool execution awaiting forever, so the turn never unwinds and the
    // controller stays busy until reload.
    for (const resolver of this.questionResolvers.values()) {
      resolver({});
    }
    this.questionResolvers.clear();
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
    let thinkingBuf = '';
    const result = await runSubscriptionTurn({
      prompt,
      workspaceRoot: this.workspaceRoot(),
      toolCtx: this.buildToolContext(session, memory, client),
      model: session.subModel ?? this.subscriptionModel(),
      resumeSessionId: session.sdkSessionId,
      minimizeOutput: minimize,
      maxTurns: 100,
      abort: this.abort!,
      requestPermission: (req) => this.requestPermission(req),
      requestQuestion: (questions) => this.requestQuestion(questions),
      onText: (delta) => this.post({ type: 'delta', text: delta }),
      onToolUse: (name, detail) => {
        this.messageStore?.add({
          chatId: session.id,
          projectPath: this.tryWorkspaceRoot() ?? 'unknown',
          role: 'tool',
          text: `${name} ${detail}`,
        });
        this.post({ type: 'toolUse', name, detail });
      },
      onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
      onNotice: (msg) => this.post({ type: 'notice', text: msg }),
      onThinking: (delta) => {
        thinkingBuf += delta;
        this.post({ type: 'thinking', text: delta });
      },
    });
    session.sdkSessionId = result.sdkSessionId ?? session.sdkSessionId;
    if (result.finalText) {
      session.assistantLog.push(result.finalText);
      this.messageStore?.add({
        chatId: session.id,
        projectPath: this.tryWorkspaceRoot() ?? 'unknown',
        role: 'assistant',
        text: result.finalText,
      });
    }
    if (thinkingBuf.trim()) {
      this.messageStore?.add({
        chatId: session.id,
        projectPath: this.tryWorkspaceRoot() ?? 'unknown',
        role: 'thinking',
        text: thinkingBuf,
      });
    }
    this.subTotals.inputTokens += result.usage.inputTokens;
    this.subTotals.outputTokens += result.usage.outputTokens;
    this.subTotals.cacheReadTokens += result.usage.cacheReadTokens;
    this.subTotals.cacheWriteTokens += result.usage.cacheWriteTokens;
    this.subTotals.requests += 1;
    this.subValueUsd += result.estValueUsd;
    this.recordUsage({
      model: session.subModel ?? this.subscriptionModel(),
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
    this.checkRateLimitWarning(result);
    return result;
  }

  /** Warns via a chat notice when a plan rate-limit window crosses the configured threshold. */
  private checkRateLimitWarning(result: SubscriptionTurnResult): void {
    const threshold = this.rateLimitWarnThreshold();
    if (threshold <= 0 || !result.rateLimit?.windows) {
      return;
    }
    for (const w of result.rateLimit.windows) {
      if (w.utilization == null) {
        continue;
      }
      if (w.utilization >= threshold) {
        if (!this.warnedRateLimitWindows.has(w.label)) {
          this.warnedRateLimitWindows.add(w.label);
          const resets = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : 'unknown';
          this.post({
            type: 'notice',
            text: `⚠️ Claude plan usage: ${w.label} at ${Math.round(w.utilization)}% (resets ${resets})`,
          });
        }
      } else {
        this.warnedRateLimitWindows.delete(w.label);
      }
    }
  }

  /**
   * Plan-limit hit mid-turn: ask escalate / wait-for-reset / cancel via the
   * standard question card. Persists a DeferredTask when the user waits, so
   * the prompt auto-resumes once the plan resets (see checkDueDeferredTasks).
   */
  private async offerLimitChoice(
    session: Session,
    originalText: string,
    result: SubscriptionTurnResult,
    canFallbackToCredits: boolean
  ): Promise<'credits' | 'escalate-plan' | 'deferred' | 'cancel'> {
    const resetsAt = await this.soonestPlanReset(result);
    const currentSubModel = session.subModel ?? this.subscriptionModel();
    const options: { label: string; description: string }[] = [];
    if (canFallbackToCredits) {
      options.push({
        label: 'Escalate to credits',
        description: `Continue this turn on ${displayName(this.ladder()[0])} using API credits.`,
      });
    } else if (currentSubModel !== 'opus') {
      options.push({
        label: 'Escalate on plan',
        description: 'Restart the task on opus on your subscription plan (no credits spent).',
      });
    }
    if (resetsAt) {
      options.push({
        label: 'Wait for plan reset',
        description: `Defer this prompt and resume it automatically when the plan resets (${new Date(resetsAt).toLocaleString()}).`,
      });
    }
    options.push({ label: 'Cancel', description: 'Drop this prompt — nothing runs and nothing is billed.' });
    const question = `Subscription limit reached (${result.errorText ?? 'usage limit'}). How should this task continue?`;
    const answers = await this.requestQuestion([
      { question, header: 'Plan limit', options, multiSelect: false },
    ]);
    const answer = answers[question];
    if (answer === 'Escalate to credits') {
      return 'credits';
    }
    if (answer === 'Escalate on plan') {
      return 'escalate-plan';
    }
    if (answer === 'Wait for plan reset' && resetsAt) {
      const store = await this.ensureDeferredTasks();
      const task = store.add(originalText, resetsAt);
      this.post({
        type: 'notice',
        text: `Task deferred (#${task.id}) — it resumes automatically after the plan resets (${new Date(resetsAt).toLocaleString()}). Use /deferred to list or cancel.`,
      });
      return 'deferred';
    }
    return 'cancel';
  }

  /** Soonest future plan-reset time: the turn's rate-limit windows first, a direct usage fetch as fallback. */
  private async soonestPlanReset(result: SubscriptionTurnResult): Promise<string | undefined> {
    const now = Date.now();
    const future = (windows: { resetsAt: string | undefined }[]): string[] =>
      windows.map((w) => w.resetsAt).filter((r): r is string => !!r && Date.parse(r) > now);
    let candidates = future(result.rateLimit?.windows ?? []);
    if (candidates.length === 0) {
      try {
        candidates = future((await fetchSubscriptionRateLimit()).windows);
      } catch (e: any) {
        this.log.appendLine(`[plan reset fetch error] ${e?.message ?? e}`);
      }
    }
    return candidates.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  }

  /**
   * Resumes the oldest deferred task whose plan-reset time has passed — one
   * per call; the 60s poll in extension.ts picks up the next. No-op while a
   * turn is running.
   */
  async checkDueDeferredTasks(): Promise<void> {
    if (this.busy) {
      return;
    }
    const store = await this.ensureDeferredTasks();
    const task = store.due(Date.now())[0];
    if (!task) {
      return;
    }
    store.markResumed(task.id);
    this.post({ type: 'notice', text: `Plan reset reached — resuming deferred task #${task.id}.` });
    await this.handleUserMessage(task.prompt);
  }

  /** `/deferred` — list pending deferred tasks, or `/deferred cancel <id>` to drop one. */
  async handleDeferredCommand(arg: string): Promise<void> {
    const store = await this.ensureDeferredTasks();
    const cancelMatch = /^cancel\s+(\d+)$/.exec(arg.trim());
    if (cancelMatch) {
      const id = Number(cancelMatch[1]);
      this.post({
        type: 'notice',
        text: store.cancel(id) ? `Deferred task #${id} cancelled.` : `No pending deferred task #${id}.`,
      });
      return;
    }
    const pending = store.pending();
    if (pending.length === 0) {
      this.post({ type: 'notice', text: 'No deferred tasks. When a plan limit defers a prompt it shows up here.' });
      return;
    }
    const lines = pending.map(
      (t) =>
        `#${t.id} — resumes ${new Date(t.resetsAt).toLocaleString()} — ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '…' : ''}`
    );
    this.post({
      type: 'notice',
      text: `Deferred tasks:\n${lines.join('\n')}\nUse /deferred cancel <id> to cancel one.`,
    });
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

  private async routePrompt(client: Anthropic | undefined, text: string): Promise<{ session: Session; planApproved: boolean }> {
    const autoDetect = this.config().get<boolean>('autoTaskDetection') ?? true;
    const session = this.sessions.current;

    if (!autoDetect) {
      return { session, planApproved: true };
    }

    try {
      const result = await classifyPrompt(client, this.tryWorkspaceRoot(), session.taskSummary, text);
      this.recordHaikuUsage('classify', session.id, result);
      const c = result.data;
      if (c.task === 'new' && session.turns > 0) {
        void this.archiveChat(session);
        const backend = this.defaultBackend();
        const fresh = this.sessions.reset(
          this.ladder()[0],
          EFFORT_BY_COMPLEXITY[c.complexity],
          undefined,
          backend,
          this.subscriptionModel()
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
        // Create the chat-history record before planning so plan-cost usage
        // (planIfNeeded records against fresh.id) isn't dropped by addUsage's
        // no-op-on-unknown-id guard.
        this.ensureChatRecord(fresh, text);
        const planApproved = await this.planIfNeeded(client, fresh, c.complexity, text);
        return { session: fresh, planApproved };
      }
      if (session.turns === 0) {
        session.taskSummary = c.summary;
        session.effort = EFFORT_BY_COMPLEXITY[c.complexity];
        this.ensureChatRecord(session, text);
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
  private async planIfNeeded(client: Anthropic | undefined, session: Session, complexity: Complexity, text: string): Promise<boolean> {
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
            // Planner-only: condense whole-file reads down to what's
            // relevant to this task before they reach the reasoning-tier
            // model, saving input tokens. Not set on the executor's ctx
            // (buildToolContext) so editing turns still see exact content.
            preprocessRead: (path: string, content: string) => this.preprocessReadForPlanning(client, path, content, text),
          }
        : undefined;
      this.post({ type: 'working', phase: 'planning', tokens: 0 });
      // Free structural orientation (language-server symbols, no LLM call)
      // so the planner targets its expensive reads instead of searching blind.
      const repoMap = plannerCtx
        ? await buildRepoMap(this.workspaceRoot(), this.repoMapTokens(), memory).catch(() => '')
        : '';
      const digest = memory.projectDigest();
      const plannerContext = [
        digest ? `<project-memory>\n${digest}\n</project-memory>` : '',
        repoMap
          ? `<repo-map>\n${repoMap}</repo-map>\nThe repo map above lists key files with their declaration signatures only — use it to pick targeted read_file/grep calls.`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      // Plan on the same backend the turn will run on: subscription sessions
      // draft the plan through the Agent SDK (billed to the Pro/Max plan, no
      // credits spent) before ever falling back to the credits reasoning tier.
      let changeFeedback = '';
      let redraftsUsed = 0;
      const MAX_PLAN_REDRAFTS = 5;
      draftLoop: for (;;) {
        const planPrompt = changeFeedback
          ? `${text}\n\nRevise the previous plan addressing this feedback:\n${changeFeedback}`
          : text;

        let plan = '';
        let toolCalls = 0;
        let truncated = false;
        let truncatedBySubMaxTurns = false;
        let noticeText = '';

        const subAlias = this.subscriptionModelAlias(model);
        if (session.backend === 'subscription' && subAlias && plannerCtx && this.tryWorkspaceRoot()) {
          const subResult = await runSubscriptionPlan({
            prompt: [
              plannerContext,
              session.taskSummary ? `Task: ${session.taskSummary}` : '',
              `Request:\n"""${planPrompt.slice(0, 4000)}"""`,
            ]
              .filter(Boolean)
              .join('\n\n'),
            workspaceRoot: this.workspaceRoot(),
            toolCtx: plannerCtx,
            model: subAlias,
            maxToolCalls: this.planningMaxToolCalls(),
            abort: this.abort!,
            onToolUse: (name, detail) => this.post({ type: 'toolUse', name: `plan:${name}`, detail }),
            onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
          });
          if ((!subResult.isError || subResult.errorText === 'error_max_turns') && subResult.plan) {
            plan = subResult.plan;
            toolCalls = subResult.toolCalls;
            truncatedBySubMaxTurns = subResult.errorText === 'error_max_turns';
            truncated = subResult.truncated || truncatedBySubMaxTurns;
            this.subTotals.inputTokens += subResult.usage.inputTokens;
            this.subTotals.outputTokens += subResult.usage.outputTokens;
            this.subTotals.cacheReadTokens += subResult.usage.cacheReadTokens;
            this.subTotals.cacheWriteTokens += subResult.usage.cacheWriteTokens;
            this.subTotals.requests += 1;
            this.subValueUsd += subResult.estValueUsd;
            this.recordUsage({
              model: subAlias,
              backend: 'subscription',
              kind: 'plan',
              sessionId: session.id,
              inputTokens: subResult.usage.inputTokens,
              outputTokens: subResult.usage.outputTokens,
              cacheReadTokens: subResult.usage.cacheReadTokens,
              cacheWriteTokens: subResult.usage.cacheWriteTokens,
              costUsd: subResult.estValueUsd,
            });
            this.chatHistoryStore?.addUsage(session.id, {
              backend: 'subscription',
              inputTokens: subResult.usage.inputTokens,
              outputTokens: subResult.usage.outputTokens,
              cacheReadTokens: subResult.usage.cacheReadTokens,
              cacheWriteTokens: subResult.usage.cacheWriteTokens,
              costUsd: subResult.estValueUsd,
              assistantChars: 0,
            });
            noticeText = `Plan drafted by ${displayName(model)} on your subscription (no credits)${toolCalls ? ` after ${toolCalls} code lookup${toolCalls === 1 ? '' : 's'}` : ''} (plan value ~${formatUsd(subResult.estValueUsd)}):\n${summarizePlan(plan)}`;
          } else {
            this.log.appendLine(`[sub planner fallback] ${subResult.errorText ?? 'no plan produced'}`);
          }
        }

        if (!plan && client) {
          const creditsResult = await planTask(client, model, session.taskSummary, planPrompt, this.planningMaxTokens(), {
            toolCtx: plannerCtx,
            maxToolCalls: this.planningMaxToolCalls(),
            context: plannerContext,
            signal: this.abort?.signal,
            onToolUse: (name, detail) => this.post({ type: 'toolUse', name: `plan:${name}`, detail }),
            onProgress: (phase, tokens) => this.post({ type: 'working', phase, tokens }),
          });
          const totals = emptyTotals();
          addUsage(totals, creditsResult.usage);
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
          this.chatHistoryStore?.addUsage(session.id, {
            backend: 'credits',
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            costUsd: costUsd(totals, model),
            assistantChars: 0,
          });
          plan = creditsResult.plan;
          toolCalls = creditsResult.toolCalls;
          truncated = creditsResult.truncated;
          noticeText = `Plan drafted by ${displayName(model)}${toolCalls ? ` after ${toolCalls} code lookup${toolCalls === 1 ? '' : 's'}` : ''} (${formatUsd(costUsd(totals, model))}):\n${summarizePlan(plan)}`;
        }

        if (!plan) {
          return true;
        }

        session.plan = plan;
        this.post({ type: 'notice', text: noticeText });
        if (truncated) {
          this.post({
            type: 'notice',
            text: truncatedBySubMaxTurns
              ? 'The plan hit its exploration turn cap even after continuing — it may be incomplete. Raise claudeCoder.planningMaxToolCalls if this keeps happening.'
              : 'The plan hit its output cap even after continuing — it may be incomplete. Raise claudeCoder.planningMaxTokens if this keeps happening.',
          });
        }

        // Escalation continuations (carryOver set) already got an explicit "escalate?" confirmation — don't ask twice.
        if (session.carryOver !== undefined || !this.requirePlanApproval()) {
          return true;
        }

        for (;;) {
          const decision = await this.requestPlanApproval(plan);
          if (decision.action === 'approve') {
            return true;
          }
          if (decision.action === 'reject') {
            session.plan = undefined;
            this.post({ type: 'notice', text: 'Plan rejected — send new instructions to draft another plan.' });
            return false;
          }
          if (decision.action === 'escalate') {
            session.plan = undefined;
            // escalate() re-enters handleUserMessage — let this turn's finally
            // release the busy flag first (same pattern as the sub usage-limit escalate above).
            setTimeout(() => void this.escalate(), 0);
            return false;
          }
          // 'change': re-draft with feedback, unless the redraft cap is spent —
          // then keep asking for a decision on the plan already drafted.
          if (redraftsUsed >= MAX_PLAN_REDRAFTS) {
            this.post({
              type: 'notice',
              text: 'Reached the change-request limit for this plan — approve, reject, or escalate to continue.',
            });
            continue;
          }
          redraftsUsed++;
          changeFeedback = decision.text ?? '';
          this.post({ type: 'notice', text: 'Re-drafting plan with your changes…' });
          continue draftLoop;
        }
      }
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
    this.sessions.reset(this.ladder()[0], undefined, undefined, this.defaultBackend(), this.subscriptionModel());
    this.post({ type: 'taskSwitch', text: 'New session started.' });
    this.postSessionInfo();
    this.updateStatusBar();
  }

  async escalate(): Promise<void> {
    const ladder = this.ladder();
    const wasSubscription = this.sessions.current.backend === 'subscription';
    const currentSubModel = this.sessions.current.subModel ?? this.subscriptionModel();
    // A subscription task that hasn't hit opus yet escalates within the plan
    // first (no credits spent) — only fall to the credits ladder once the
    // plan's top model has already been tried.
    const escalateWithinPlan = wasSubscription && currentSubModel !== 'opus';
    let next: string | undefined;
    if (!escalateWithinPlan) {
      if (wasSubscription) {
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
    }
    this.cancel();
    const carryOver = this.sessions.buildEscalationCarryOver();
    const summary = this.sessions.current.taskSummary;
    let fresh: Session;
    let noticeText: string;
    if (escalateWithinPlan) {
      fresh = this.sessions.reset(ladder[0], 'xhigh', carryOver, 'subscription', 'opus');
      noticeText =
        'Escalated to opus on your subscription plan (no credits spent). The task restarts fresh with a summary of the previous attempt.';
    } else {
      fresh = this.sessions.reset(next!, 'xhigh', carryOver, 'credits');
      noticeText = `Escalated to ${displayName(next!)} on API credits (effort xhigh). The task restarts fresh with a summary of the previous attempt.`;
    }
    fresh.taskSummary = summary;
    this.post({ type: 'taskSwitch', text: noticeText });
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
    const taskMemoryStore = await this.ensureTaskMemory();
    const root = this.tryWorkspaceRoot();

    const notes = memory.listNotes(20);
    const changes = memory.recentChanges(30);
    const summaries = memory.listSummaries(30);

    const fileSummaries = (
      await Promise.all(
        summaries.map(async (s) => {
          const status = await this.summaryFreshness(root, s);
          if (status === 'deleted') {
            memory.forgetFile(s.path);
            return undefined;
          }
          const firstLine = s.summary?.split('\n').find((l) => l.trim()) ?? '';
          return {
            path: s.path,
            summary: firstLine,
            status,
            summarizedAt: s.summarizedAt ?? 0,
            detail: s.summaryDetail ?? 'concise',
            readCount: s.readCount ?? 0,
          };
        })
      )
    ).filter(
      (s): s is { path: string; summary: string; status: string; summarizedAt: number; detail: 'concise' | 'detailed'; readCount: number } =>
        !!s
    );

    const taskMemories = root
      ? taskMemoryStore.forProject(root, 50).map((m) => ({
          id: m.id,
          title: m.title,
          summary: m.summary,
          files: Object.keys(m.files),
          staleFiles: m.staleFiles ?? [],
          chatIds: m.chatIds,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }))
      : [];

    MemoryPanel.show(
      { notes, changes, fileSummaries, taskMemories, root },
      (p) => void this.reloadCachedFile(p),
      (p) => void this.openMemoryFile(p)
    );
  }

  /** Opens a cached file's actual source beside the Memory panel (file-summary row click). */
  private async openMemoryFile(filePath: string): Promise<void> {
    const root = this.tryWorkspaceRoot();
    const abs = root ? (path.isAbsolute(filePath) ? filePath : path.join(root, filePath)) : filePath;
    try {
      const uri = vscode.Uri.file(abs);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch {
      MemoryPanel.notice('Could not open file (it may have been deleted)');
    }
  }

  /** Manually refreshes a single file's read-cache summary (Memory panel "Reload" button). */
  private async reloadCachedFile(filePath: string): Promise<void> {
    const memory = await this.ensureMemory();
    const root = this.tryWorkspaceRoot();
    const abs = root ? (path.isAbsolute(filePath) ? filePath : path.join(root, filePath)) : filePath;
    let notice: string;
    try {
      const content = await fs.readFile(abs, 'utf8');
      const stat = await fs.stat(abs);
      const client = await this.tryGetClient();
      const summary = await this.summarizeFileForMemory(client, filePath, content);
      if (summary) {
        memory.saveSummary(filePath, stat.mtimeMs, stat.size, summary);
        notice = 'Summary reloaded';
      } else {
        notice = 'Reload failed (see output)';
      }
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        memory.forgetFile(filePath);
        notice = 'File no longer exists — removed from cache';
      } else {
        this.log.appendLine(`[memory reload error] ${e?.message ?? e}`);
        notice = 'Reload failed (see output)';
      }
    }
    await this.showMemory();
    MemoryPanel.notice(notice);
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
    pastSummaries: SummaryRecord[],
    taskMemories: TaskMemory[]
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
    const taskMemoryText = taskMemories.length
      ? taskMemories
          .map((m) => {
            const files = Object.keys(m.files);
            const staleNote = m.staleFiles?.length ? ` [stale: ${m.staleFiles.join(', ')} changed since — verify before relying on it]` : '';
            return `- ${m.title}: ${m.summary}${files.length ? ` (files: ${files.join(', ')})` : ''}${staleNote}`;
          })
          .join('\n')
      : '';
    const parts = [
      `<context>`,
      `Workspace root: ${root}`,
      openFiles.length ? `Open editor tabs: ${openFiles.join(', ')}` : '',
      `</context>`,
      chatHistory ? `<chat-history>\n${chatHistory}\n</chat-history>` : '',
      taskMemoryText ? `<task-memory>\n${taskMemoryText}\n</task-memory>` : '',
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

  /** Lazily opens (or creates) the per-workspace task-memory file — see taskMemoryStore.ts. */
  private async ensureTaskMemory(): Promise<TaskMemoryStore> {
    if (!this.taskMemory) {
      const dir = this.context.storageUri?.fsPath ?? path.join(this.workspaceRoot(), '.claudeCoder');
      this.taskMemory = await TaskMemoryStore.load(path.join(dir, 'task-memories.json'));
    }
    return this.taskMemory;
  }

  /** Lazily opens (or creates) the per-workspace deferred-task file — see deferredTaskStore.ts. */
  private async ensureDeferredTasks(): Promise<DeferredTaskStore> {
    if (!this.deferredTasks) {
      const dir = this.context.storageUri?.fsPath ?? path.join(this.workspaceRoot(), '.claudeCoder');
      this.deferredTasks = await DeferredTaskStore.load(path.join(dir, 'deferred-tasks.json'));
    }
    return this.deferredTasks;
  }

  private async statTaskMemoryFiles(root: string, paths: string[]): Promise<Record<string, TaskMemoryFile>> {
    const entries = await Promise.all(
      paths.map(async (p): Promise<[string, TaskMemoryFile] | undefined> => {
        try {
          const st = await fs.stat(path.join(root, p));
          return [p, { mtimeMs: st.mtimeMs, size: st.size }];
        } catch {
          return undefined; // deleted or unreadable — drop from tracking
        }
      })
    );
    return Object.fromEntries(entries.filter((e): e is [string, TaskMemoryFile] => !!e));
  }

  /**
   * Best-effort: create or refresh this task's memory from the files it has
   * touched so far (see MemoryStore.recentChanges) plus a cheap Haiku summary
   * of the transcript. Called mid-task every ~5 prompts (maybeUpdateTaskMemory)
   * and once more at task end (archiveChat) so the memory stays in sync with
   * what actually happened, without waiting for the task to finish.
   */
  private async upsertTaskMemory(session: Session, client: Anthropic | undefined): Promise<void> {
    const root = this.tryWorkspaceRoot();
    if (!root || session.turns === 0) {
      return;
    }
    try {
      const memory = await this.ensureMemory();
      const store = await this.ensureTaskMemory();
      const taskId = String(session.id);
      const touched = [...new Set(memory.recentChanges(50).filter((c) => c.taskId === taskId).map((c) => c.path))];
      if (touched.length === 0) {
        return;
      }
      const existing = session.activeTaskMemoryId ? store.get(session.activeTaskMemoryId) : undefined;
      const files = await this.statTaskMemoryFiles(root, touched);
      const result = await createTaskMemory(client, root, session, touched, existing?.summary);
      this.recordHaikuUsage('summarize', session.id, result);
      const summary = [result.data.summary, ...result.data.keyPoints.map((k) => `- ${k}`)].join('\n');
      if (existing) {
        store.update(existing.id, {
          title: session.taskSummary || existing.title,
          summary,
          files: { ...existing.files, ...files },
          chatIds: [...new Set([...existing.chatIds, session.id])],
          staleFiles: [],
        });
      } else {
        const created = store.add({
          projectPath: root,
          title: session.taskSummary || '(untitled task)',
          summary,
          files,
          chatIds: [session.id],
        });
        session.activeTaskMemoryId = created.id;
      }
    } catch (e: any) {
      this.log.appendLine(`[task-memory error] ${e?.message ?? e}`);
    }
  }

  /** Refreshes this task's memory every ~5 prompts, so long tasks don't wait until archiveChat to record what was touched. */
  private async maybeUpdateTaskMemory(session: Session, client: Anthropic | undefined): Promise<void> {
    if (session.turns === 0 || session.promptCount % 5 !== 0) {
      return;
    }
    await this.upsertTaskMemory(session, client);
  }

  /**
   * Best-effort: ask Haiku which task memories in this project (if any) are
   * relevant to the upcoming task, so a new task can fast-forward on files it
   * has already touched instead of rediscovering them. Falls back to recency
   * on error.
   */
  private async findRelevantTaskMemories(client: Anthropic | undefined, upcomingTask: string): Promise<TaskMemory[]> {
    const root = this.tryWorkspaceRoot();
    if (!root) {
      return [];
    }
    const store = await this.ensureTaskMemory();
    const candidates = store.forProject(root, 20);
    if (candidates.length === 0) {
      return [];
    }
    try {
      const result = await findRelevantMemories(
        client,
        root,
        upcomingTask,
        candidates.map((m) => ({ id: m.id, title: m.title, summary: m.summary }))
      );
      this.recordHaikuUsage('recall', this.sessions.current.id, result);
      const byId = new Map(candidates.map((m) => [m.id, m]));
      return result.data.map((id) => byId.get(id)).filter((m): m is TaskMemory => !!m);
    } catch (e: any) {
      this.log.appendLine(`[task-memory recall error] ${e?.message ?? e}`);
      return candidates.slice(0, 3);
    }
  }

  /**
   * Background freshness check for task memories: stats every tracked file
   * and flags ones whose mtime/size moved since the memory was last
   * refreshed (i.e. edited outside the extension — extension edits always
   * go through upsertTaskMemory, which resyncs the tracked stat). Purely
   * mechanical, no model call — cheap enough to run on a timer (see
   * extension.ts) without surprising API spend. Skipped while a turn is
   * in flight so it never contends with real work.
   */
  async pollTaskMemoryFreshness(): Promise<void> {
    if (this.busy) {
      return;
    }
    const root = this.tryWorkspaceRoot();
    if (!root) {
      return;
    }
    try {
      const store = await this.ensureTaskMemory();
      for (const mem of store.forProject(root)) {
        const files: Record<string, TaskMemoryFile> = {};
        const staleFiles: string[] = [];
        let changed = false;
        for (const [rel, tracked] of Object.entries(mem.files)) {
          try {
            const st = await fs.stat(path.join(root, rel));
            if (st.mtimeMs !== tracked.mtimeMs || st.size !== tracked.size) {
              staleFiles.push(rel);
              files[rel] = { mtimeMs: st.mtimeMs, size: st.size };
              changed = true;
            } else {
              files[rel] = tracked;
            }
          } catch {
            changed = true; // file deleted — drop it from tracking
          }
        }
        if (changed) {
          store.update(mem.id, { files, staleFiles });
        }
      }
    } catch (e: any) {
      this.log.appendLine(`[task-memory poll error] ${e?.message ?? e}`);
    }
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
      summarizeFile: (path, content, detailed) => this.summarizeFileForMemory(client, path, content, detailed),
      askQuestion: (questions) => this.requestQuestion(questions),
      searchMemory: (task) => this.searchProjectMemories(client, task),
    };
  }

  /**
   * Backs the search_memory tool: asks Haiku (subscription-first, credits
   * fallback — see findRelevantMemories) which of this project's task
   * memories relate to the given task, and formats a short summary of each
   * (title, summary, files touched). Returns 'none' when there is no task
   * memory for this project or nothing relevant is found.
   */
  private async searchProjectMemories(client: Anthropic | undefined, task: string): Promise<string> {
    const root = this.tryWorkspaceRoot();
    if (!root) {
      return 'none';
    }
    const store = await this.ensureTaskMemory();
    const candidates = store.forProject(root, 20);
    if (candidates.length === 0) {
      return 'none';
    }
    try {
      const result = await findRelevantMemories(
        client,
        root,
        task,
        candidates.map((m) => ({ id: m.id, title: m.title, summary: m.summary })),
        5
      );
      this.recordHaikuUsage('recall', this.sessions.current.id, result);
      const byId = new Map(candidates.map((m) => [m.id, m]));
      const matches = result.data.map((id) => byId.get(id)).filter((m): m is TaskMemory => !!m);
      if (matches.length === 0) {
        return 'none';
      }
      return matches
        .map((m) => `- ${m.title}: ${m.summary} (files: ${Object.keys(m.files).join(', ') || 'none'})`)
        .join('\n');
    } catch (e: any) {
      this.log.appendLine(`[search-memory error] ${e?.message ?? e}`);
      return 'none';
    }
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
      this.chatHistoryStore?.addUsage(sessionId, {
        backend: 'subscription',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: result.estValueUsd,
        assistantChars: 0,
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
      this.chatHistoryStore?.addUsage(sessionId, {
        backend: 'credits',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: costUsd({ ...result.usage, requests: 1 }, CLASSIFIER_MODEL),
        assistantChars: 0,
      });
    }
  }

  /**
   * Best-effort file digest for the lazy read-file summary cache (see
   * tools.ts readFileTool / memory.ts MemoryStore.saveSummary). Never throws
   * — a missed summary just means the next read falls back to raw content.
   */
  private async summarizeFileForMemory(client: Anthropic | undefined, filePath: string, content: string, detailed = false): Promise<string | undefined> {
    try {
      const result = await summarizeFile(client, this.tryWorkspaceRoot(), filePath, content, detailed);
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

  /**
   * Best-effort task-focused condenser for planner reads (see tools.ts
   * readFileTool preprocessRead). Never throws — a missed condensation just
   * falls through to the normal numbered file output.
   */
  private async preprocessReadForPlanning(
    client: Anthropic | undefined,
    filePath: string,
    content: string,
    task: string
  ): Promise<string | undefined> {
    try {
      const result = await preprocessFileForPlanning(client, this.tryWorkspaceRoot(), filePath, content, task);
      this.recordHaikuUsage('preprocess', this.sessions.current.id, result);
      return result.data;
    } catch (e: any) {
      this.log.appendLine(`[file preprocess error] ${e?.message ?? e}`);
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
      model: session.backend === 'subscription' ? session.subModel ?? this.subscriptionModel() : session.model,
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
  /** Arms a save that fires if the user hasn't replied within IDLE_SAVE_DELAY_MS
   *  of the assistant finishing a turn. Reset on every new user message. */
  private armIdleSave(session: Session): void {
    this.clearIdleSave();
    this.idleSaveTimer = setTimeout(() => {
      this.idleSaveTimer = undefined;
      if (!this.busy) {
        void this.archiveChat(session);
      }
    }, Controller.IDLE_SAVE_DELAY_MS);
  }

  private clearIdleSave(): void {
    if (this.idleSaveTimer) {
      clearTimeout(this.idleSaveTimer);
      this.idleSaveTimer = undefined;
    }
  }

  /** Best-effort flush when the extension is shutting down, so an active,
   *  unarchived chat isn't lost. */
  async flushMemoryOnClose(): Promise<void> {
    this.clearIdleSave();
    await this.archiveChat(this.sessions.current);
  }

  private async archiveChat(session: Session): Promise<void> {
    const sessionKey = String(session.id);
    if (!this.summaryStore || session.turns === 0 || session.turns === this.lastArchivedTurns.get(sessionKey)) {
      return;
    }
    this.post({ type: 'memoryPending', active: true, text: 'Saving to memory…' });
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
      await this.upsertTaskMemory(session, client);
      this.lastArchivedTurns.set(sessionKey, session.turns);
      this.post({ type: 'notice', text: 'Saved to memory.' });
    } catch (e: any) {
      this.log.appendLine(`[summarize error] ${e?.message ?? e}`);
    } finally {
      this.post({ type: 'memoryPending', active: false });
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
      ? `${s.subModel ?? this.subscriptionModel()} on your plan`
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
    const label = s.backend === 'subscription' ? `${s.subModel ?? this.subscriptionModel()} (plan)` : displayName(s.model);
    this.statusBar.text = `${spin}${label} · ${formatUsd(this.grandTotal())}`;
    this.statusBar.tooltip =
      `Claude Coder — credits: session ${formatUsd(s.cost)}, total ${formatUsd(this.grandTotal())}. ` +
      `Subscription: ${this.subTotals.requests} runs, est. value ${formatUsd(this.subValueUsd)}. Click for details.`;
  }

  dispose(): void {
    this.clearIdleSave();
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
/**
 * Opening the plan file (openTextDocument/showTextDocument) crosses the
 * extension-host <-> renderer RPC stream, which can drop transiently
 * (especially remote/SSH windows) right as a chat turn hands off into plan
 * mode. Retry only on that class of error — a real failure (bad path,
 * permissions) should surface immediately, not get masked by retries.
 */
function withTransientRetry<T>(op: () => Promise<T>): Promise<T> {
  return withRetry(op);
}

/** Usage/rate-limit failures only — the cases where waiting for the plan reset makes sense. */
function isUsageLimitError(errorText: string | undefined): boolean {
  if (!errorText) {
    return false;
  }
  return /usage limit|rate limit|rate_limit|429|quota|too many requests/.test(errorText.toLowerCase());
}

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
