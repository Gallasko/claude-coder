import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Locates the user's Claude Code CLI install and login state. Shared by the
 * subscription backend (which spawns the CLI) and the setup wizard (which
 * reports/repairs missing pieces). Kept free of vscode imports so the agent
 * layer stays UI-agnostic.
 */

/** An error whose right "fix" is the setup wizard, not a raw error toast. */
export class SetupNeededError extends Error {
  readonly setupNeeded = true;
  constructor(
    message: string,
    readonly reason: 'cli-missing' | 'cli-logged-out' | 'no-api-key'
  ) {
    super(message);
    this.name = 'SetupNeededError';
  }
}

let cachedCliPath: string | undefined;

/** Call after the wizard installs/moves the CLI so the next turn re-resolves it. */
export function resetCliCache(): void {
  cachedCliPath = undefined;
}

function execFirstLine(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.split('\n')[0]?.trim() || undefined)
    );
  });
}

/** Places installers drop the binary that may not be on the extension host's PATH. */
function fallbackLocations(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  ];
}

/** Absolute path to the Claude Code CLI, or undefined if not installed. */
export async function findClaudeCli(): Promise<string | undefined> {
  if (cachedCliPath) {
    return cachedCliPath;
  }
  const onPath = await execFirstLine(process.platform === 'win32' ? 'where' : 'which', ['claude']);
  const found =
    onPath ??
    fallbackLocations().find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  if (found) {
    cachedCliPath = found;
  }
  return found;
}

export function cliVersion(cliPath: string): Promise<string | undefined> {
  return execFirstLine(cliPath, ['--version']);
}

/**
 * Whether the CLI holds a subscription login. Reads local config markers only
 * (no network, no usage): the credentials file, or the oauthAccount entry in
 * ~/.claude.json. Returns 'unknown' where credentials may live elsewhere
 * (e.g. the macOS keychain) — callers should treat 'unknown' as "probably ok".
 */
export function detectCliLogin(): boolean | 'unknown' {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    if (fs.existsSync(path.join(configDir, '.credentials.json'))) {
      return true;
    }
    const globalConfig = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(globalConfig)) {
      const parsed = JSON.parse(fs.readFileSync(globalConfig, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.oauthAccount) {
        return true;
      }
      return process.platform === 'darwin' ? 'unknown' : false;
    }
    return false;
  } catch {
    return 'unknown';
  }
}
