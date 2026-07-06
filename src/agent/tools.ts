import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import type Anthropic from '@anthropic-ai/sdk';

const MAX_READ_LINES = 1500;
const MAX_LINE_LEN = 500;
const MAX_GREP_MATCHES = 150;
const MAX_GREP_FILES = 3000;
const MAX_RESULT_CHARS = 40_000;
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * Tool definitions. This array must stay STABLE and in a fixed order — tools
 * render at position 0 of the prompt, so any change invalidates the entire
 * prompt cache for the session.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read a file. Returns numbered lines. Use offset/limit for large files. Paths outside the workspace require user permission.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path' },
        offset: { type: 'number', description: '1-based line to start from (optional)' },
        limit: { type: 'number', description: 'Max lines to return (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent directories are created.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. Include enough surrounding context to make it unique.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path' },
        old_string: { type: 'string', description: 'Exact text to replace (no line-number prefixes)' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern, e.g. "src/**/*.ts". Returns up to 200 paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to workspace root' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Returns matching lines as path:line:text. Call this to locate code before reading files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        include: { type: 'string', description: 'Optional glob to restrict files, e.g. "**/*.ts"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command at the workspace root (non-interactive, 120s timeout). Returns stdout, stderr and exit code. Use for builds, tests, git, package managers. The user approves each command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'get_diagnostics',
    description:
      "Get VS Code language-server diagnostics (errors/warnings). Use after editing to verify you didn't break anything. Omit path to get all workspace diagnostics.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional workspace-relative file path to filter on' },
      },
      required: [],
    },
  },
];

export interface PermissionRequest {
  kind: 'command' | 'edit' | 'outside-read' | 'outside-write';
  /** Stable identifier used for "yes, always" (e.g. "command:npm", "read:/etc"). */
  key: string;
  title: string;
  detail: string;
}

export interface ToolContext {
  workspaceRoot: string;
  /** Ask the user (in the chat panel). Resolves true if allowed. */
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
}

const DENIED = 'The user denied permission for this action. Ask them how to proceed or take another approach.';

function resolvePath(root: string, p: string): { abs: string; outside: boolean; display: string } {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);
  return { abs, outside, display: outside ? abs : rel };
}

function truncate(s: string, max = MAX_RESULT_CHARS): string {
  return s.length > max ? s.slice(0, max) + `\n[... truncated, ${s.length} chars total]` : s;
}

function preview(s: string, max = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
}

async function readFileTool(ctx: ToolContext, input: any): Promise<string> {
  const { abs, outside } = resolvePath(ctx.workspaceRoot, input.path);
  if (outside) {
    const ok = await ctx.requestPermission({
      kind: 'outside-read',
      key: `read:${path.dirname(abs)}`,
      title: 'Read a file outside the workspace',
      detail: abs,
    });
    if (!ok) {
      throw new Error(DENIED);
    }
  }
  const raw = await fs.readFile(abs, 'utf8');
  const lines = raw.split('\n');
  const offset = Math.max(1, Number(input.offset) || 1);
  const limit = Math.min(Number(input.limit) || MAX_READ_LINES, MAX_READ_LINES);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((l, i) => `${offset + i}\t${l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l}`)
    .join('\n');
  const footer =
    offset - 1 + limit < lines.length
      ? `\n[showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}]`
      : '';
  return truncate(numbered + footer);
}

async function writeFileTool(ctx: ToolContext, input: any): Promise<string> {
  const { abs, outside, display } = resolvePath(ctx.workspaceRoot, input.path);
  const content = String(input.content);
  const ok = outside
    ? await ctx.requestPermission({
        kind: 'outside-write',
        key: `write:${path.dirname(abs)}`,
        title: 'Write a file outside the workspace',
        detail: `${abs}\n(${content.length} chars)`,
      })
    : await ctx.requestPermission({
        kind: 'edit',
        key: 'workspace-edits',
        title: `Write ${display}`,
        detail: `${display} (${content.length} chars)\n${preview(content, 300)}`,
      });
  if (!ok) {
    throw new Error(DENIED);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return `Wrote ${display} (${content.length} chars)`;
}

async function editFileTool(ctx: ToolContext, input: any): Promise<string> {
  const { abs, outside, display } = resolvePath(ctx.workspaceRoot, input.path);
  const oldStr = String(input.old_string);
  const newStr = String(input.new_string);
  const ok = outside
    ? await ctx.requestPermission({
        kind: 'outside-write',
        key: `write:${path.dirname(abs)}`,
        title: 'Edit a file outside the workspace',
        detail: `${abs}\n- ${preview(oldStr)}\n+ ${preview(newStr)}`,
      })
    : await ctx.requestPermission({
        kind: 'edit',
        key: 'workspace-edits',
        title: `Edit ${display}`,
        detail: `- ${preview(oldStr)}\n+ ${preview(newStr)}`,
      });
  if (!ok) {
    throw new Error(DENIED);
  }
  const raw = await fs.readFile(abs, 'utf8');
  if (!raw.includes(oldStr)) {
    throw new Error('old_string not found in file. Read the file and match the content exactly.');
  }
  let updated: string;
  if (input.replace_all) {
    updated = raw.split(oldStr).join(newStr);
  } else {
    const count = raw.split(oldStr).length - 1;
    if (count > 1) {
      throw new Error(
        `old_string appears ${count} times. Add surrounding context to make it unique, or set replace_all.`
      );
    }
    updated = raw.replace(oldStr, newStr);
  }
  await fs.writeFile(abs, updated, 'utf8');
  return `Edited ${display}`;
}

async function globTool(_ctx: ToolContext, input: any): Promise<string> {
  const uris = await vscode.workspace.findFiles(String(input.pattern), '**/node_modules/**', 200);
  if (uris.length === 0) {
    return 'No files matched.';
  }
  return uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n');
}

async function grepTool(_ctx: ToolContext, input: any): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(String(input.pattern));
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }
  const include = input.include ? String(input.include) : '**/*';
  const uris = await vscode.workspace.findFiles(include, '**/node_modules/**', MAX_GREP_FILES);
  const matches: string[] = [];
  for (const uri of uris) {
    if (matches.length >= MAX_GREP_MATCHES) {
      break;
    }
    let text: string;
    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > 1_000_000) {
        continue;
      }
      text = await fs.readFile(uri.fsPath, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) {
      continue; // binary
    }
    const rel = vscode.workspace.asRelativePath(uri);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 250)}`);
      }
    }
  }
  if (matches.length === 0) {
    return 'No matches.';
  }
  const header = matches.length >= MAX_GREP_MATCHES ? `[first ${MAX_GREP_MATCHES} matches]\n` : '';
  return truncate(header + matches.join('\n'));
}

async function runCommandTool(ctx: ToolContext, input: any): Promise<string> {
  const command = String(input.command);
  const firstWord = command.trim().split(/\s+/)[0] ?? command;
  const ok = await ctx.requestPermission({
    kind: 'command',
    key: `command:${firstWord}`,
    title: 'Run command',
    detail: command,
  });
  if (!ok) {
    return DENIED;
  }
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      { cwd: ctx.workspaceRoot, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4_000_000 },
      (error, stdout, stderr) => {
        const code = error ? ((error as any).code ?? 1) : 0;
        const timedOut = error && (error as any).killed;
        resolve(
          truncate(
            [
              `exit code: ${timedOut ? 'timeout after 120s' : code}`,
              stdout ? `stdout:\n${stdout}` : '',
              stderr ? `stderr:\n${stderr}` : '',
            ]
              .filter(Boolean)
              .join('\n')
          )
        );
      }
    );
  });
}

async function diagnosticsTool(ctx: ToolContext, input: any): Promise<string> {
  const sevName = ['Error', 'Warning', 'Info', 'Hint'];
  let entries: [vscode.Uri, readonly vscode.Diagnostic[]][];
  if (input.path) {
    const { abs, outside } = resolvePath(ctx.workspaceRoot, input.path);
    if (outside) {
      throw new Error('Diagnostics are only available for workspace files.');
    }
    const uri = vscode.Uri.file(abs);
    entries = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    entries = vscode.languages.getDiagnostics();
  }
  const lines: string[] = [];
  for (const [uri, diags] of entries) {
    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) {
        continue;
      }
      lines.push(
        `${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1} [${sevName[d.severity]}] ${d.message}`
      );
    }
  }
  return lines.length === 0 ? 'No errors or warnings.' : truncate(lines.slice(0, 200).join('\n'));
}

const EXECUTORS: Record<string, (ctx: ToolContext, input: any) => Promise<string>> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  glob: globTool,
  grep: grepTool,
  run_command: runCommandTool,
  get_diagnostics: diagnosticsTool,
};

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export async function executeTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
  const exec = EXECUTORS[name];
  if (!exec) {
    return { content: `Unknown tool: ${name}`, isError: true };
  }
  try {
    return { content: await exec(ctx, input), isError: false };
  } catch (e) {
    return { content: `Error: ${(e as Error).message}`, isError: true };
  }
}
