import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import type Anthropic from '@anthropic-ai/sdk';
import { MemoryStore } from './memory';

const MAX_READ_LINES = 1500;
const MAX_LINE_LEN = 500;
const MAX_GREP_MATCHES = 150;
const MAX_GREP_FILES = 3000;
const MAX_RESULT_CHARS = 40_000;
const COMMAND_TIMEOUT_MS = 120_000;
/** Read count at which a file's cached summary is upgraded from a quick digest to a fuller, detailed one. */
const DETAILED_SUMMARY_THRESHOLD = 3;

/**
 * Tool definitions. This array must stay STABLE and in a fixed order — tools
 * render at position 0 of the prompt, so any change invalidates the entire
 * prompt cache for the session.
 */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description:
      'Read a file. Returns numbered lines. Use offset/limit for large files. Paths outside the workspace require user permission. ' +
      'A whole-file read may return a cached summary instead of the raw content to save context, clearly labeled as such — ' +
      'pass full:true to force the exact raw content (required before editing with edit_file).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path' },
        offset: { type: 'number', description: '1-based line to start from (optional)' },
        limit: { type: 'number', description: 'Max lines to return (optional)' },
        full: { type: 'boolean', description: 'Force the exact raw content even if a cached summary is available (optional)' },
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
    name: 'multi_edit_file',
    description:
      'Apply several edit_file-style replacements to one file atomically (one diff, one approval). Edits are applied in order; each old_string must match the content as it stands after the previous edits.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute file path' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to replace (no line-number prefixes)' },
              new_string: { type: 'string', description: 'Replacement text' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
            },
            required: ['old_string', 'new_string'],
          },
          description: 'Ordered list of edits to apply',
        },
      },
      required: ['path', 'edits'],
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
  {
    name: 'ask_question',
    description:
      'Ask the user one or more clarifying multiple-choice questions when genuinely blocked on a decision only they can make. ' +
      'Do not use this for things discoverable by reading the code. 1-4 questions, 2-4 options each.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The complete question to ask, ending with a question mark' },
              header: { type: 'string', description: 'Very short label for this question (max 12 chars)' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Short display text for this choice' },
                    description: { type: 'string', description: 'What this option means or implies' },
                  },
                  required: ['label', 'description'],
                },
                description: '2-4 distinct, mutually exclusive choices (unless multiSelect is true)',
              },
              multiSelect: { type: 'boolean', description: 'Allow selecting more than one option' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
          description: '1-4 questions to ask the user',
        },
      },
      required: ['questions'],
    },
  },
];

export interface AskQuestionItem {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

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
  /** Like requestPermission, but also opens a native diff editor for the proposed change. Resolves true if allowed. */
  requestEditApproval: (
    req: PermissionRequest,
    before: string,
    after: string,
    filePath: string,
    fileExists: boolean
  ) => Promise<boolean>;
  /** Persistent per-project cache of read hashes + edit history. */
  memory: MemoryStore;
  taskId: string;
  taskSummary: string;
  /** Whole-file hashes already sent in this session's transcript (in-memory, per Session). */
  readCache: Map<string, string>;
  /** Best-effort file summarizer for the lazy read cache (see summarizer.ts summarizeFile). Absent when no API client is configured. `detailed` requests the fuller digest for frequently-read files. */
  summarizeFile?: (path: string, content: string, detailed?: boolean) => Promise<string | undefined>;
  /**
   * Task-focused condenser for planner reads (see summarizer.ts
   * preprocessFileForPlanning) — strips content irrelevant to the current
   * task before it reaches the reasoning-tier model. Distinct from
   * summarizeFile's whole-file digest cache. Only set on planner contexts;
   * its presence is what marks a ctx as a planner ctx.
   */
  preprocessRead?: (path: string, content: string, task: string) => Promise<string | undefined>;
  /** Ask the user one or more clarifying multiple-choice questions in the chat. Resolves to answers keyed by question text. */
  askQuestion: (questions: AskQuestionItem[]) => Promise<Record<string, string>>;
}

function fileHash(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
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
  const { abs, outside, display } = resolvePath(ctx.workspaceRoot, input.path);
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
  const wholeFile = !input.offset && !input.limit;
  const forceFull = !!input.full;

  await ctx.memory.whenSaved();

  // Lazy summary cache: for a whole-file read, check size+mtime against the
  // stored record BEFORE touching the file's content — if a summary was
  // generated against this exact size+mtime, serve it instead of reading and
  // resending the raw file. Skipped once a session has already read the file
  // raw (readCache below takes over from there).
  if (wholeFile && !forceFull) {
    try {
      const stat = await fs.stat(abs);
      const cached = ctx.memory.freshSummary(display, stat.mtimeMs, stat.size);
      if (cached) {
        const readCount = ctx.memory.bumpReadCount(display);
        const record = ctx.memory.getFileRecord(display);
        // Cache hits skip the raw read that normally feeds the summarizer below — once
        // a file is hot enough to warrant the detailed digest, read it once in the
        // background to upgrade the cached summary in place.
        if (ctx.summarizeFile && readCount >= DETAILED_SUMMARY_THRESHOLD && record?.summaryDetail !== 'detailed') {
          fs.readFile(abs, 'utf8')
            .then((raw) =>
              ctx.summarizeFile!(display, raw, true).then((summary) => {
                if (summary) {
                  ctx.memory.saveSummary(display, stat.mtimeMs, stat.size, summary, 'detailed');
                }
              })
            )
            .catch(() => undefined);
        }
        return (
          `${display}: cached summary (unchanged since last summarized) — pass full:true to read the exact ` +
          `file content (required before editing).\n\n${cached}`
        );
      }
    } catch {
      // fall through to the real read below, which will surface the error
    }
  }

  const raw = await fs.readFile(abs, 'utf8');
  const hash = fileHash(raw);
  const readCount = ctx.memory.noteRead(display, hash);

  // Whole-file reads already sent verbatim earlier in this session don't
  // need to be resent — the model still has them in its own transcript.
  if (wholeFile && ctx.readCache.get(display) === hash) {
    return `${display}: unchanged since it was read in full earlier in this session (hash ${hash}) — reuse that content, no need to re-read.`;
  }

  // Planner-only: condense the file down to what's relevant to the task
  // before it reaches the reasoning-tier model. Never applied to partial
  // reads (already targeted) or forced full reads (editing needs exact
  // content). Not written to the persistent summary cache — that cache is
  // keyed to whole-file digests, not task-specific relevance.
  if (wholeFile && !forceFull && ctx.preprocessRead && !raw.includes(String.fromCharCode(0)) && raw.length > 2000) {
    try {
      const condensed = await ctx.preprocessRead(display, raw, ctx.taskSummary);
      if (condensed) {
        ctx.readCache.set(display, hash);
        return `${display}: condensed for planning — pass full:true / offset for exact lines.\n\n${condensed}`;
      }
    } catch {
      // fall through to the normal numbered output below
    }
  }

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
  const result = truncate(numbered + footer);
  if (wholeFile) {
    ctx.readCache.set(display, hash);
    const detailed = readCount >= DETAILED_SUMMARY_THRESHOLD;
    // Best-effort, never blocks this read: refresh the summary cache for
    // next time, keyed to the size+mtime just read.
    if (ctx.summarizeFile && !raw.includes('\u0000') && raw.length > 2000) {
      fs.stat(abs)
        .then((stat) => ctx.summarizeFile!(display, raw, detailed).then((summary) => {
          if (summary) {
            ctx.memory.saveSummary(display, stat.mtimeMs, stat.size, summary, detailed ? 'detailed' : 'concise');
          }
        }))
        .catch(() => undefined);
    }
  }
  return result;
}

async function writeFileTool(ctx: ToolContext, input: any): Promise<string> {
  const { abs, outside, display } = resolvePath(ctx.workspaceRoot, input.path);
  const content = String(input.content);
  let before = '';
  let existed = false;
  try {
    before = await fs.readFile(abs, 'utf8');
    existed = true;
  } catch {
    // file didn't exist yet
  }
  const ok = outside
    ? await ctx.requestEditApproval(
        {
          kind: 'outside-write',
          key: `write:${path.dirname(abs)}`,
          title: 'Write a file outside the workspace',
          detail: `${abs}\n(${content.length} chars)`,
        },
        before,
        content,
        abs,
        existed
      )
    : await ctx.requestEditApproval(
        {
          kind: 'edit',
          key: 'workspace-edits',
          title: `Write ${display}`,
          detail: `${display} (${content.length} chars)\n${preview(content, 300)}`,
        },
        before,
        content,
        abs,
        existed
      );
  if (!ok) {
    throw new Error(DENIED);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  ctx.memory.noteChange({
    taskId: ctx.taskId,
    taskSummary: ctx.taskSummary,
    path: display,
    tool: 'write_file',
    before: before ? preview(before, 300) : '(new file)',
    after: preview(content, 300),
  });
  ctx.readCache.set(display, fileHash(content));
  return `Wrote ${display} (${content.length} chars)`;
}

async function editFileTool(ctx: ToolContext, input: any): Promise<string> {
  const { abs, outside, display } = resolvePath(ctx.workspaceRoot, input.path);
  const oldStr = String(input.old_string);
  const newStr = String(input.new_string);
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
  const ok = outside
    ? await ctx.requestEditApproval(
        {
          kind: 'outside-write',
          key: `write:${path.dirname(abs)}`,
          title: 'Edit a file outside the workspace',
          detail: `${abs}\n- ${preview(oldStr)}\n+ ${preview(newStr)}`,
        },
        raw,
        updated,
        abs,
        true
      )
    : await ctx.requestEditApproval(
        {
          kind: 'edit',
          key: 'workspace-edits',
          title: `Edit ${display}`,
          detail: `- ${preview(oldStr)}\n+ ${preview(newStr)}`,
        },
        raw,
        updated,
        abs,
        true
      );
  if (!ok) {
    throw new Error(DENIED);
  }
  await fs.writeFile(abs, updated, 'utf8');
  ctx.memory.noteChange({
    taskId: ctx.taskId,
    taskSummary: ctx.taskSummary,
    path: display,
    tool: 'edit_file',
    before: preview(oldStr, 300),
    after: preview(newStr, 300),
  });
  ctx.readCache.set(display, fileHash(updated));
  return `Edited ${display}`;
}

async function multiEditFileTool(ctx: ToolContext, input: any): Promise<string> {
  const { abs, outside, display } = resolvePath(ctx.workspaceRoot, input.path);
  const edits = Array.isArray(input.edits) ? input.edits : [];
  if (edits.length === 0) {
    throw new Error('edits must be a non-empty array.');
  }
  const raw = await fs.readFile(abs, 'utf8');
  let content = raw;
  const summary: string[] = [];
  for (const [i, edit] of edits.entries()) {
    const oldStr = String(edit.old_string);
    const newStr = String(edit.new_string);
    if (!content.includes(oldStr)) {
      throw new Error(`old_string not found for edit ${i + 1}. Read the file and match the content exactly.`);
    }
    if (edit.replace_all) {
      content = content.split(oldStr).join(newStr);
    } else {
      const count = content.split(oldStr).length - 1;
      if (count > 1) {
        throw new Error(
          `old_string for edit ${i + 1} appears ${count} times. Add surrounding context to make it unique, or set replace_all.`
        );
      }
      content = content.replace(oldStr, newStr);
    }
    summary.push(`- ${preview(oldStr)}\n+ ${preview(newStr)}`);
  }
  const ok = outside
    ? await ctx.requestEditApproval(
        {
          kind: 'outside-write',
          key: `write:${path.dirname(abs)}`,
          title: 'Edit a file outside the workspace',
          detail: `${abs}\n${summary.join('\n')}`,
        },
        raw,
        content,
        abs,
        true
      )
    : await ctx.requestEditApproval(
        {
          kind: 'edit',
          key: 'workspace-edits',
          title: `Edit ${display} (${edits.length} edits)`,
          detail: summary.join('\n'),
        },
        raw,
        content,
        abs,
        true
      );
  if (!ok) {
    throw new Error(DENIED);
  }
  await fs.writeFile(abs, content, 'utf8');
  ctx.memory.noteChange({
    taskId: ctx.taskId,
    taskSummary: ctx.taskSummary,
    path: display,
    tool: 'multi_edit_file',
    before: preview(raw, 300),
    after: preview(content, 300),
  });
  ctx.readCache.set(display, fileHash(content));
  return `Edited ${display} (${edits.length} edits)`;
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

async function askQuestionTool(ctx: ToolContext, input: any): Promise<string> {
  const questions: AskQuestionItem[] = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length === 0) {
    throw new Error('questions must be a non-empty array.');
  }
  const answers = await ctx.askQuestion(questions);
  return JSON.stringify({ answers });
}

const EXECUTORS: Record<string, (ctx: ToolContext, input: any) => Promise<string>> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  multi_edit_file: multiEditFileTool,
  glob: globTool,
  grep: grepTool,
  run_command: runCommandTool,
  get_diagnostics: diagnosticsTool,
  ask_question: askQuestionTool,
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
