import * as path from 'path';
import { z } from 'zod';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequest, ToolContext } from './tools';
import { executeTool } from './tools';
import { SUBSCRIPTION_SYSTEM_APPEND, MINIMAL_OUTPUT_ADDENDUM } from './prompt';
import { findClaudeCli, SetupNeededError } from './cliLocator';
import { supportsAdaptiveThinking } from './models';

/**
 * Exposes our own read_file implementation (lazy summary cache, permission
 * checks, memory tracking — see tools.ts) as an in-process MCP server, so the
 * Agent SDK's subprocess reads files through it instead of its built-in Read
 * tool. `disallowedTools: ['Read']` below forces that route.
 */
function buildWorkspaceFsServer(toolCtx: ToolContext) {
  return createSdkMcpServer({
    name: 'workspace-fs',
    tools: [
      tool(
        'read_file',
        'Read a file. Returns numbered lines. Use offset/limit for large files. Paths outside the workspace require user permission.',
        {
          path: z.string().describe('Workspace-relative or absolute file path'),
          offset: z.number().optional().describe('1-based line to start from'),
          limit: z.number().optional().describe('Max lines to return'),
          full: z.boolean().optional().describe('Force the exact raw content even if a cached summary is available'),
        },
        async (args) => {
          const outcome = await executeTool(toolCtx, 'read_file', args);
          return { content: [{ type: 'text', text: outcome.content }], isError: outcome.isError };
        }
      ),
    ],
  });
}

/**
 * Subscription backend: runs the task through the Claude Agent SDK, which
 * authenticates with the user's local Claude Code login and draws from their
 * Pro/Max subscription instead of API credits. ANTHROPIC_API_KEY is stripped
 * from the child environment so usage can never silently bill credits.
 */

export interface SubUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SubscriptionTurnResult {
  finalText: string;
  sdkSessionId: string | undefined;
  /** Estimated API-equivalent value of the turn (informational — not billed). */
  estValueUsd: number;
  usage: SubUsage;
  isError: boolean;
  errorText: string | undefined;
  numTurns: number;
}

export interface SubscriptionTurnParams {
  prompt: string;
  workspaceRoot: string;
  /** Backs the workspace-fs MCP server (see buildWorkspaceFsServer) so file reads go through our custom read_file, not the SDK's built-in Read tool. */
  toolCtx: ToolContext;
  /** 'sonnet' | 'opus' | 'haiku' or a full model id. */
  model: string;
  resumeSessionId: string | undefined;
  minimizeOutput: boolean;
  maxTurns: number;
  abort: AbortController;
  requestPermission: (req: PermissionRequest) => Promise<boolean>;
  onText: (delta: string) => void;
  onToolUse: (name: string, detail: string) => void;
  onProgress: (phase: string, approxTokens: number) => void;
  onNotice: (message: string) => void;
  /** Extended-thinking text as it streams in, when the SDK surfaces it. */
  onThinking?: (delta: string) => void;
}

const PROGRESS_INTERVAL_MS = 300;
const CHARS_PER_TOKEN = 4;
const DENY_MESSAGE = 'The user denied permission for this action. Adjust your approach or ask them.';

/**
 * The SDK's built-in CLI resolution breaks once we bundle the extension, so
 * we point it at the user's installed Claude Code binary — which must exist
 * anyway, since it holds the subscription login this backend runs on.
 */
async function findClaudeExecutable(): Promise<string> {
  const found = await findClaudeCli();
  if (!found) {
    throw new SetupNeededError(
      'Claude Code CLI not found on this machine — it holds the subscription login this backend runs on.',
      'cli-missing'
    );
  }
  return found;
}

export async function runSubscriptionTurn(p: SubscriptionTurnParams): Promise<SubscriptionTurnResult> {
  let approxChars = 0;
  let lastEmit = 0;
  let lastPhase = '';
  const progress = (phase: string, chars: number, force = false) => {
    approxChars += chars;
    const now = Date.now();
    if (force || phase !== lastPhase || now - lastEmit > PROGRESS_INTERVAL_MS) {
      lastPhase = phase;
      lastEmit = now;
      p.onProgress(phase, Math.round(approxChars / CHARS_PER_TOKEN));
    }
  };

  const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    const req = mapToolToPermission(toolName, input, p.workspaceRoot);
    if (!req) {
      return { behavior: 'allow', updatedInput: input };
    }
    const ok = await p.requestPermission(req);
    return ok
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: DENY_MESSAGE };
  };

  // Force subscription auth: never let the child process see the API key.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN') {
      env[k] = v;
    }
  }

  const claudeExecutable = await findClaudeExecutable();

  const options: Options = {
    cwd: p.workspaceRoot,
    model: p.model,
    pathToClaudeCodeExecutable: claudeExecutable,
    maxTurns: p.maxTurns,
    includePartialMessages: true,
    abortController: p.abort,
    canUseTool,
    env,
    settingSources: [],
    // Route file reads through our own read_file (lazy summary cache,
    // permission checks, memory tracking) instead of the SDK's built-in Read.
    // disallowedTools removes Read's own schema/definition from the model's
    // context entirely, so it can only see and call our MCP tool below —
    // toolAliases would keep Read's `file_path`-shaped schema visible and
    // redirect by name only, risking an input-shape mismatch with our tool.
    mcpServers: { 'workspace-fs': buildWorkspaceFsServer(p.toolCtx) },
    disallowedTools: ['Read'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: p.minimizeOutput
        ? SUBSCRIPTION_SYSTEM_APPEND + MINIMAL_OUTPUT_ADDENDUM
        : SUBSCRIPTION_SYSTEM_APPEND,
    },
    // Force summarized display so thinking_delta events carry real text —
    // without this the CLI's own default can leave `thinking` empty (only
    // `estimated_tokens` ticks up), so the thinking box renders with nothing
    // written in it. Thinking is still billed as part of the plan's usage,
    // so (unlike credits) we don't skip it under minimizeOutput.
    ...(supportsAdaptiveThinking(p.model)
      ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
      : {}),
    ...(p.resumeSessionId ? { resume: p.resumeSessionId } : {}),
  };

  let sdkSessionId: string | undefined;
  let finalText = '';
  let estValueUsd = 0;
  let numTurns = 0;
  let isError = false;
  let errorText: string | undefined;
  const usage: SubUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  progress('sending request', 0, true);

  for await (const message of query({ prompt: p.prompt, options }) as AsyncIterable<SDKMessage>) {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          sdkSessionId = message.session_id;
        }
        break;

      case 'stream_event': {
        // Skip subagent streams for text output; still count them as activity.
        const fromSubagent = message.parent_tool_use_id != null;
        const event: any = message.event;
        if (event?.type === 'content_block_delta') {
          const d = event.delta;
          if (d?.type === 'text_delta') {
            progress(fromSubagent ? 'subagent working' : 'writing', (d.text ?? '').length);
            if (!fromSubagent) {
              p.onText(d.text ?? '');
            }
          } else if (d?.type === 'thinking_delta') {
            progress('thinking', (d.thinking ?? '').length);
            if (!fromSubagent) {
              p.onThinking?.(d.thinking ?? '');
            }
          } else if (d?.type === 'input_json_delta') {
            progress('preparing tool call', (d.partial_json ?? '').length);
          }
        }
        break;
      }

      case 'assistant': {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            p.onToolUse(block.name, previewToolInput(block.input));
          } else if (block.type === 'text' && message.parent_tool_use_id == null) {
            finalText = block.text;
          }
        }
        break;
      }

      case 'result': {
        numTurns = message.num_turns;
        estValueUsd = message.total_cost_usd ?? 0;
        const u: any = (message as any).usage;
        if (u) {
          usage.inputTokens = u.input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        }
        if (message.subtype !== 'success') {
          isError = true;
          errorText = message.subtype;
        } else if (message.is_error) {
          isError = true;
          errorText = message.result;
        } else if (message.result && !finalText) {
          finalText = message.result;
        }
        break;
      }

      default:
        break;
    }
  }

  return { finalText, sdkSessionId, estValueUsd, usage, isError, errorText, numTurns };
}

/**
 * Map Claude Code tool calls onto our permission cards. Returning undefined
 * means "allow silently" (workspace reads, searches, internal bookkeeping).
 * Keys are shared with the credits backend, so "yes, always" answers apply
 * to both.
 */
function mapToolToPermission(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string
): PermissionRequest | undefined {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const outside = (fp: string) => {
    const abs = path.resolve(workspaceRoot, fp);
    const rel = path.relative(workspaceRoot, abs);
    return { abs, isOutside: rel.startsWith('..') || path.isAbsolute(rel) };
  };

  switch (toolName) {
    case 'Bash': {
      const command = String(input.command ?? '');
      const firstWord = command.trim().split(/\s+/)[0] ?? command;
      return { kind: 'command', key: `command:${firstWord}`, title: 'Run command', detail: command };
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (!filePath) {
        return { kind: 'edit', key: 'workspace-edits', title: `${toolName} (unknown path)`, detail: JSON.stringify(input).slice(0, 200) };
      }
      const { abs, isOutside } = outside(filePath);
      if (isOutside) {
        return {
          kind: 'outside-write',
          key: `write:${path.dirname(abs)}`,
          title: `${toolName === 'Write' ? 'Write' : 'Edit'} a file outside the workspace`,
          detail: abs,
        };
      }
      return {
        kind: 'edit',
        key: 'workspace-edits',
        title: `${toolName === 'Write' ? 'Write' : 'Edit'} ${path.relative(workspaceRoot, abs)}`,
        detail: summarizeEdit(toolName, input),
      };
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const target = filePath ?? (typeof input.path === 'string' ? input.path : undefined);
      if (target) {
        const { abs, isOutside } = outside(target);
        if (isOutside) {
          return {
            kind: 'outside-read',
            key: `read:${path.dirname(abs)}`,
            title: 'Read outside the workspace',
            detail: abs,
          };
        }
      }
      return undefined;
    }
    default:
      // WebSearch/WebFetch/TodoWrite/Task and other internal tools: read-only
      // or harmless — allow without interrupting the user.
      return undefined;
  }
}

function summarizeEdit(toolName: string, input: Record<string, unknown>): string {
  const one = (s: unknown, max = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (toolName === 'Write') {
    return `(${String(input.content ?? '').length} chars)\n${one(input.content, 250)}`;
  }
  if (toolName === 'Edit') {
    return `- ${one(input.old_string)}\n+ ${one(input.new_string)}`;
  }
  return one(JSON.stringify(input), 250);
}

function previewToolInput(input: unknown): string {
  const i = input as any;
  if (typeof i?.command === 'string') {
    return i.command.slice(0, 120);
  }
  if (typeof i?.file_path === 'string') {
    return i.file_path;
  }
  if (typeof i?.pattern === 'string') {
    return i.pattern;
  }
  try {
    return JSON.stringify(i).slice(0, 120);
  } catch {
    return '';
  }
}
