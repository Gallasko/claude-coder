import * as vscode from 'vscode';
import type { MemoryStore } from './memory';

/**
 * Aider-style repo map, VS Code-native: a token-budgeted digest of the
 * workspace's key files and their declaration signatures. Where Aider parses
 * with tree-sitter, we ask the already-running language servers via
 * executeDocumentSymbolProvider — zero dependencies, any language the user
 * has support for. Fed to the planner so it orients itself structurally
 * before spending reasoning-tier tokens on grep/read calls.
 */

const SOURCE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,h,cc,cpp,hpp,cs,rb,php,swift,kt,kts,scala,lua,vue,svelte}';
const EXCLUDE_GLOB =
  '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.git/**,**/vendor/**,**/*.min.*}';
const MAX_FILES_SCANNED = 400;
const MAX_SYMBOL_LINES_PER_FILE = 18;
const MAX_DECL_CHARS = 120;
const CHARS_PER_TOKEN = 4;
/** Language servers can be slow to warm up — never stall planning past this. */
const BUILD_DEADLINE_MS = 8000;
const CACHE_TTL_MS = 5 * 60_000;

/** Container kinds whose immediate children (methods etc.) are worth a line each. */
const CONTAINER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Enum,
]);

/** Declaration kinds worth listing; top-level `const x = 3` noise is skipped. */
const LISTED_KINDS = new Set<vscode.SymbolKind>([
  ...CONTAINER_KINDS,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.EnumMember,
]);

let cache: { key: string; builtAt: number; text: string } | undefined;

export function invalidateRepoMap(): void {
  cache = undefined;
}

export async function buildRepoMap(
  workspaceRoot: string,
  tokenBudget: number,
  memory?: MemoryStore
): Promise<string> {
  if (tokenBudget <= 0) {
    return '';
  }
  const key = `${workspaceRoot}:${tokenBudget}`;
  if (cache && cache.key === key && Date.now() - cache.builtAt < CACHE_TTL_MS) {
    return cache.text;
  }

  const deadline = Date.now() + BUILD_DEADLINE_MS;
  const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, MAX_FILES_SCANNED);

  // Rank without a reference graph (Aider uses PageRank): files the memory
  // saw edited recently first, then non-test over test, then fresh mtime.
  const recentlyChanged = new Set((memory?.recentChanges(30) ?? []).map((c) => c.path));
  const candidates = await Promise.all(
    uris.map(async (uri) => {
      const rel = vscode.workspace.asRelativePath(uri);
      let mtime = 0;
      try {
        mtime = (await vscode.workspace.fs.stat(uri)).mtime;
      } catch {
        // unstatable — rank last
      }
      return {
        uri,
        rel,
        recent: recentlyChanged.has(rel),
        test: /(^|\/)(test|tests|spec|__tests__)\/|\.(test|spec)\.|\.d\.ts$/.test(rel),
        mtime,
      };
    })
  );
  candidates.sort((a, b) => {
    if (a.recent !== b.recent) {
      return a.recent ? -1 : 1;
    }
    if (a.test !== b.test) {
      return a.test ? 1 : -1;
    }
    return b.mtime - a.mtime;
  });

  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let used = 0;
  for (const c of candidates) {
    if (used >= budgetChars || Date.now() > deadline) {
      break;
    }
    const block = await fileSymbolBlock(c.uri, c.rel);
    if (!block || used + block.length > budgetChars) {
      continue; // too big for what's left — a smaller file may still fit
    }
    parts.push(block);
    used += block.length;
  }

  const text = parts.join('\n');
  cache = { key, builtAt: Date.now(), text };
  return text;
}

/** One file's entry: relative path, then its declaration lines verbatim. */
async function fileSymbolBlock(uri: vscode.Uri, rel: string): Promise<string | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.lineCount > 20_000) {
      return undefined;
    }
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
    if (!symbols?.length) {
      return undefined;
    }
    const lines: string[] = [];
    const push = (s: vscode.DocumentSymbol, depth: number) => {
      if (lines.length >= MAX_SYMBOL_LINES_PER_FILE || !LISTED_KINDS.has(s.kind)) {
        return;
      }
      const decl = doc.lineAt(s.selectionRange.start.line).text.trim();
      if (!decl) {
        return;
      }
      lines.push('  '.repeat(depth + 1) + (decl.length > MAX_DECL_CHARS ? decl.slice(0, MAX_DECL_CHARS) + '…' : decl));
      if (depth === 0 && CONTAINER_KINDS.has(s.kind)) {
        for (const child of s.children) {
          push(child, 1);
        }
      }
    };
    for (const s of symbols) {
      push(s, 0);
    }
    return lines.length ? `${rel}:\n${lines.join('\n')}\n` : undefined;
  } catch {
    return undefined; // no provider for this language, unreadable file, etc.
  }
}
