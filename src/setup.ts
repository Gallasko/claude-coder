import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { cliVersion, detectCliLogin, findClaudeCli, resetCliCache } from './agent/cliLocator';

/**
 * Guided setup: detects what auth already exists (Claude Code login for the
 * subscription backend, API key for the credits backend) and walks the user
 * through fixing whatever is missing — install, login, key entry — without
 * leaving VS Code. Entered from the chat's setup card, the /setup slash
 * command, or the "Claude Coder: Setup" command.
 */

export interface SetupState {
  cliPath: string | undefined;
  cliVersion: string | undefined;
  /** 'unknown' when we can't tell locally (e.g. credentials in the OS keychain). */
  cliLoggedIn: boolean | 'unknown';
  hasStoredKey: boolean;
  hasEnvKey: boolean;
}

export async function detectSetup(context: vscode.ExtensionContext): Promise<SetupState> {
  resetCliCache(); // the wizard may have just installed it — never trust a stale miss
  const cliPath = await findClaudeCli();
  return {
    cliPath,
    cliVersion: cliPath ? await cliVersion(cliPath) : undefined,
    cliLoggedIn: cliPath ? detectCliLogin() : false,
    hasStoredKey: Boolean(await context.secrets.get('claudeCoder.apiKey')),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

export function subscriptionReady(s: SetupState): boolean {
  return Boolean(s.cliPath) && s.cliLoggedIn !== false;
}

export function creditsReady(s: SetupState): boolean {
  return s.hasStoredKey || s.hasEnvKey;
}

/** Human-readable list of what's missing, for the chat setup card. */
export function describeSetupGap(s: SetupState): string {
  const lines: string[] = [];
  if (!s.cliPath) {
    lines.push('• Claude subscription: Claude Code CLI is not installed.');
  } else if (s.cliLoggedIn === false) {
    lines.push(`• Claude subscription: Claude Code is installed (${s.cliVersion ?? 'version unknown'}) but not logged in.`);
  } else {
    lines.push(`• Claude subscription: ready (${s.cliVersion ?? 'Claude Code detected'}).`);
  }
  lines.push(
    creditsReady(s)
      ? `• API credits: key configured${s.hasEnvKey && !s.hasStoredKey ? ' (from ANTHROPIC_API_KEY)' : ''}.`
      : '• API credits: no API key configured.'
  );
  return lines.join('\n');
}

function subscriptionStatus(s: SetupState): string {
  if (!s.cliPath) {
    return 'Claude Code CLI not installed yet';
  }
  if (s.cliLoggedIn === false) {
    return `Claude Code installed (${s.cliVersion ?? 'version unknown'}), not logged in`;
  }
  return `Claude Code installed (${s.cliVersion ?? 'version unknown'})${s.cliLoggedIn === true ? ', logged in' : ''}`;
}

function creditsStatus(s: SetupState): string {
  if (s.hasStoredKey) {
    return 'API key already stored';
  }
  if (s.hasEnvKey) {
    return 'using ANTHROPIC_API_KEY from the environment';
  }
  return 'no API key yet';
}

const TERMINAL_NAME = 'Claude Coder setup';

function setupTerminal(): vscode.Terminal {
  const term =
    vscode.window.terminals.find((t) => t.name === TERMINAL_NAME && !t.exitStatus) ??
    vscode.window.createTerminal(TERMINAL_NAME);
  term.show();
  return term;
}

type PickItem = vscode.QuickPickItem & { id: string };

function pick(items: PickItem[], title: string, placeHolder?: string): Thenable<PickItem | undefined> {
  return vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true });
}

/**
 * Prompt for an Anthropic API key, verify it against the (free) models
 * endpoint, and store it in secret storage. Returns true if a key was saved.
 */
export async function promptAndStoreApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    prompt: 'Anthropic API key (console.anthropic.com → API keys). Stored in VS Code secret storage.',
    placeHolder: 'sk-ant-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.trim() && !v.trim().startsWith('sk-ant-')
        ? {
            message: 'Anthropic keys usually start with sk-ant-',
            severity: vscode.InputBoxValidationSeverity.Warning,
          }
        : undefined,
  });
  if (!key || !key.trim()) {
    return false;
  }
  const trimmed = key.trim();

  const verdict = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude Coder: verifying the API key…' },
    async (): Promise<'ok' | 'invalid' | 'unreachable'> => {
      try {
        await new Anthropic({ apiKey: trimmed }).models.list();
        return 'ok';
      } catch (e) {
        return e instanceof Anthropic.AuthenticationError ? 'invalid' : 'unreachable';
      }
    }
  );

  if (verdict === 'invalid') {
    const next = await vscode.window.showErrorMessage(
      'The Anthropic API rejected that key.',
      'Re-enter key',
      'Save it anyway'
    );
    if (next === 'Re-enter key') {
      return promptAndStoreApiKey(context);
    }
    if (next !== 'Save it anyway') {
      return false;
    }
  } else if (verdict === 'unreachable') {
    vscode.window.showWarningMessage(
      "Claude Coder: couldn't reach the Anthropic API to verify the key — saved it unverified."
    );
  }

  await context.secrets.store('claudeCoder.apiKey', trimmed);
  vscode.window.showInformationMessage('Claude Coder: API key saved.');
  return true;
}

/**
 * The wizard. Returns a summary line for the chat when setup completes, or
 * undefined if the user cancelled. Config changes (useSubscription, the
 * stored key) persist even on a later cancel — they're individually valid.
 */
export async function runSetupWizard(context: vscode.ExtensionContext): Promise<string | undefined> {
  let state = await detectSetup(context);
  const config = () => vscode.workspace.getConfiguration('claudeCoder');

  const backend = await pick(
    [
      {
        id: 'subscription',
        label: '$(cloud) Use my Claude subscription (Pro/Max)',
        description: 'recommended',
        detail: `${subscriptionStatus(state)} — tasks run on your plan; an optional API key adds planning & auto task detection.`,
      },
      {
        id: 'credits',
        label: '$(key) Use API credits',
        detail: `${creditsStatus(state)} — everything is billed to your Anthropic API account.`,
      },
    ],
    'Claude Coder setup — how should tasks run?',
    'You can rerun this any time with /setup or "Claude Coder: Setup"'
  );
  if (!backend) {
    return undefined;
  }

  // ---------- credits path ----------
  if (backend.id === 'credits') {
    if (!state.hasStoredKey) {
      const saved = await promptAndStoreApiKey(context);
      state = await detectSetup(context);
      if (!saved && !creditsReady(state)) {
        return undefined;
      }
    }
    await config().update('useSubscription', false, vscode.ConfigurationTarget.Global);
    return `Setup complete — tasks run on API credits (${creditsStatus(state)}).`;
  }

  // ---------- subscription path ----------
  // Step 1: make sure the CLI exists.
  while (!state.cliPath) {
    const action = await pick(
      [
        {
          id: 'native',
          label: '$(terminal) Install Claude Code (native installer)',
          detail:
            process.platform === 'win32'
              ? 'Runs `irm https://claude.ai/install.ps1 | iex` in a terminal.'
              : 'Runs `curl -fsSL https://claude.ai/install.sh | bash` in a terminal.',
        },
        {
          id: 'npm',
          label: '$(package) Install Claude Code via npm',
          detail: 'Runs `npm install -g @anthropic-ai/claude-code` in a terminal.',
        },
        { id: 'docs', label: '$(link-external) Open the install docs in a browser' },
        { id: 'check', label: '$(refresh) I installed it — check again' },
      ],
      'Claude Coder setup · step 1 of 3 — install Claude Code',
      'The subscription backend runs through your local Claude Code login'
    );
    if (!action) {
      return undefined;
    }
    if (action.id === 'native') {
      setupTerminal().sendText(
        process.platform === 'win32'
          ? 'irm https://claude.ai/install.ps1 | iex'
          : 'curl -fsSL https://claude.ai/install.sh | bash',
        true
      );
    } else if (action.id === 'npm') {
      setupTerminal().sendText('npm install -g @anthropic-ai/claude-code', true);
    } else if (action.id === 'docs') {
      void vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/en/docs/claude-code/setup'));
    }
    state = await detectSetup(context);
  }

  // Step 2: make sure it's logged in.
  while (state.cliLoggedIn === false) {
    const action = await pick(
      [
        {
          id: 'login',
          label: '$(terminal) Open a terminal and log in',
          detail: 'Starts `claude` — pick "Claude account with subscription", or type /login if not prompted.',
        },
        { id: 'check', label: '$(refresh) I logged in — check again' },
        { id: 'skip', label: '$(arrow-right) Skip this check — I know I\'m logged in' },
      ],
      'Claude Coder setup · step 2 of 3 — log in to Claude',
      `Found Claude Code at ${state.cliPath}`
    );
    if (!action) {
      return undefined;
    }
    if (action.id === 'login') {
      setupTerminal().sendText('claude', true);
    }
    if (action.id === 'skip') {
      break;
    }
    state = await detectSetup(context);
  }

  await config().update('useSubscription', true, vscode.ConfigurationTarget.Global);

  // Step 3: optional API key for the utility features (Haiku classifier,
  // Opus/Fable planning, compaction, escalation) — those always bill credits.
  let keyNote =
    ' Auto task detection, planning and compaction use your existing API key for cheap utility calls.';
  if (!creditsReady(state)) {
    const addKey = await pick(
      [
        {
          id: 'yes',
          label: '$(key) Add an API key too',
          description: 'recommended',
          detail: 'Enables auto task detection, planning and compaction (cheap Haiku/Opus utility calls on credits).',
        },
        {
          id: 'no',
          label: '$(arrow-right) Skip — subscription only',
          detail: 'Those utility features stay off until you add a key later.',
        },
      ],
      'Claude Coder setup · step 3 of 3 — optional API key'
    );
    if (addKey?.id === 'yes' && (await promptAndStoreApiKey(context))) {
      keyNote = ' API key saved — auto task detection, planning and compaction are on.';
    } else {
      keyNote =
        ' Running subscription-only: auto task detection, planning and compaction stay off until you add an API key (/setup or "Claude Coder: Set API Key").';
    }
  }

  return 'Setup complete — tasks run on your Claude subscription.' + keyNote;
}
