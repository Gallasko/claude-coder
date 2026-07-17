import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequest, ToolContext, AskQuestionItem } from './tools';
import { executeTool } from './tools';
import { SUBSCRIPTION_SYSTEM_APPEND, MINIMAL_OUTPUT_ADDENDUM } from './prompt';
import { findClaudeCli, SetupNeededError } from './cliLocator';
import { supportsAdaptiveThinking, CLASSIFIER_MODEL } from './models';
import { PLAN_SYSTEM } from './planner';
import { withRetry } from './retry';

/**
 * Exposes the same tool set the credits backend uses (see tools.ts:
 * read_file, write_file, edit_file, multi_edit_file, glob, grep,
 * get_diagnostics) as an in-process MCP server, so the Agent SDK's
 * subprocess routes file access through our lazy summary cache, permission
 * checks, memory tracking, and diff-based edit approval instead of its
 * built-in Read/Write/Edit/MultiEdit/Grep/Glob tools. `disallowedTools`
 * below forces that route; Bash, NotebookEdit and other SDK-native tools
 * have no canonical equivalent here and stay on the plain
 * requestPermission path (see mapToolToPermission).
 */
function buildWorkspaceFsServer(toolCtx: ToolContext) {
  const passthrough =
    (name: string) =>
    async (args: unknown) => {
      const outcome = await executeTool(toolCtx, name, args);
      return { content: [{ type: 'text' as const, text: outcome.content }], isError: outcome.isError };
    };

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
        passthrough('read_file')
      ),
      tool(
        'write_file',
        'Create or overwrite a file with the given content. Parent directories are created.',
        {
          path: z.string().describe('Workspace-relative or absolute file path'),
          content: z.string().describe('Full file content'),
        },
        passthrough('write_file')
      ),
      tool(
        'edit_file',
        'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. Include enough surrounding context to make it unique.',
        {
          path: z.string().describe('Workspace-relative or absolute file path'),
          old_string: z.string().describe('Exact text to replace (no line-number prefixes)'),
          new_string: z.string().describe('Replacement text'),
          replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
        },
        passthrough('edit_file')
      ),
      tool(
        'multi_edit_file',
        'Apply several edit_file-style replacements to one file atomically (one diff, one approval). Edits are applied in order; each old_string must match the content as it stands after the previous edits.',
        {
          path: z.string().describe('Workspace-relative or absolute file path'),
          edits: z
            .array(
              z.object({
                old_string: z.string().describe('Exact text to replace (no line-number prefixes)'),
                new_string: z.string().describe('Replacement text'),
                replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
              })
            )
            .describe('Ordered list of edits to apply'),
        },
        passthrough('multi_edit_file')
      ),
      tool(
        'glob',
        'Find files matching a glob pattern, e.g. "src/**/*.ts". Returns up to 200 paths.',
        {
          pattern: z.string().describe('Glob pattern relative to workspace root'),
        },
        passthrough('glob')
      ),
      tool(
        'grep',
        'Search file contents with a regular expression. Returns matching lines as path:line:text. Call this to locate code before reading files.',
        {
          pattern: z.string().describe('JavaScript regular expression'),
          include: z.string().optional().describe('Optional glob to restrict files, e.g. "**/*.ts"'),
        },
        passthrough('grep')
      ),
      tool(
        'get_diagnostics',
        "Get VS Code language-server diagnostics (errors/warnings). Use after editing to verify you didn't break anything. Omit path to get all workspace diagnostics.",
        {
          path: z.string().optional().describe('Optional workspace-relative file path to filter on'),
        },
        passthrough('get_diagnostics')
      ),
      tool(
        'search_memory',
        'Search project memory for prior or related tasks before starting work; returns a summary of matching past tasks and files touched, or `none`.',
        {
          task_description: z.string().describe('What the current task is about'),
        },
        passthrough('search_memory')
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

export interface SubscriptionRateLimitWindow {
  label: string;
  utilization: number | undefined;
  resetsAt: string | undefined;
}

export interface SubscriptionRateLimit {
  windows: SubscriptionRateLimitWindow[];
}

/** Shared between the opportunistic SDKRateLimitEvent capture and the direct oauth/usage fetch below. */
const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly (overage included)',
  overage: 'Overage',
};

export interface SubscriptionTurnResult {
  finalText: string;
  sdkSessionId: string | undefined;
  /** Estimated API-equivalent value of the turn (informational — not billed). */
  estValueUsd: number;
  usage: SubUsage;
  isError: boolean;
  errorText: string | undefined;
  numTurns: number;
  /** Plan rate-limit windows observed via SDKRateLimitEvent during this turn, if the SDK emitted any. */
  rateLimit?: SubscriptionRateLimit;
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
  requestQuestion: (questions: AskQuestionItem[]) => Promise<Record<string, string>>;
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
 * Bash spellings of file reads/searches/edits. With the built-in Read/Grep
 * hidden by disallowedTools, models reach for `cat`/`grep`/`sed` instead of
 * the namespaced workspace-fs tools — sidestepping the read cache, memory
 * tracking and diff approval. The prompt already forbids this but gets
 * ignored, so canUseTool auto-denies these with a redirect (no permission
 * card); the model retries with the right tool.
 */
const FS_COMMAND_REDIRECTS: Record<string, string> = {
  cat: 'mcp__workspace-fs__read_file',
  head: 'mcp__workspace-fs__read_file with offset/limit',
  tail: 'mcp__workspace-fs__read_file with offset/limit',
  nl: 'mcp__workspace-fs__read_file',
  tac: 'mcp__workspace-fs__read_file',
  less: 'mcp__workspace-fs__read_file',
  more: 'mcp__workspace-fs__read_file',
  sed: 'mcp__workspace-fs__read_file with offset/limit to read line ranges, or mcp__workspace-fs__edit_file to modify files',
  awk: 'mcp__workspace-fs__grep or mcp__workspace-fs__read_file',
  grep: 'mcp__workspace-fs__grep',
  rg: 'mcp__workspace-fs__grep',
  egrep: 'mcp__workspace-fs__grep',
  fgrep: 'mcp__workspace-fs__grep',
  find: 'mcp__workspace-fs__glob',
  fd: 'mcp__workspace-fs__glob',
};

function redirectFsCommand(command: string): { cmd: string; message: string } | undefined {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const bare = first.replace(/^.*\//, ''); // /usr/bin/grep → grep
  const target = FS_COMMAND_REDIRECTS[bare];
  if (!target) {
    return undefined;
  }
  return {
    cmd: bare,
    message:
      `Rejected automatically: do not use \`${bare}\` via Bash on workspace files. ` +
      `Use ${target} instead — the workspace-fs tools are cached, memory-tracked, and handle their own approvals. ` +
      'Retry now with the equivalent workspace-fs tool call.',
  };
}

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

/** Force subscription auth: never let the child process see the API key. */
function buildSubscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN') {
      env[k] = v;
    }
  }
  return env;
}

function readOauthAccessToken(): string | undefined {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const credPath = path.join(configDir, '.credentials.json');
    if (!fs.existsSync(credPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetches claude.ai plan rate-limit utilization (5-hour + weekly windows)
 * from the same local Claude Code login the subscription backend runs turns
 * on. Undocumented endpoint — parsed defensively, only fields present are
 * surfaced. Never uses ANTHROPIC_API_KEY; this is the OAuth token only.
 */
export async function fetchSubscriptionRateLimit(): Promise<SubscriptionRateLimit> {
  const token = readOauthAccessToken();
  if (!token) {
    throw new SetupNeededError(
      'No Claude Code subscription login found — run `claude` in a terminal to log in.',
      'cli-logged-out'
    );
  }

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });

  if (response.status === 401) {
    throw new SetupNeededError(
      'Claude Code login expired — run `claude` in a terminal to log in again.',
      'cli-logged-out'
    );
  }
  if (!response.ok) {
    throw new Error(`Rate limit lookup failed: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();
  const windows: SubscriptionRateLimitWindow[] = [];
  for (const key of Object.keys(RATE_LIMIT_LABELS)) {
    const w = data?.[key];
    if (w && typeof w === 'object') {
      windows.push({
        label: RATE_LIMIT_LABELS[key],
        utilization: typeof w.utilization === 'number' ? w.utilization : undefined,
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : undefined,
      });
    }
  }
  return { windows };
}

function withPermissionRetry<T>(
  op: () => Promise<T>,
  onNotice: (message: string) => void,
  label: string,
  signal: AbortSignal,
): Promise<T> {
  return withRetry(op, {
    signal,
    onRetry: () => onNotice(`Reconnecting to request permission for "${label}"…`),
  });
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

  // One notice per command kind per turn — the model may probe a few times
  // before it switches, and each denial is already fed back to it.
  const redirectedCmds = new Set<string>();

  const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') {
      const questions = ((input as Record<string, unknown>).questions ?? []) as AskQuestionItem[];
      const answers = await withPermissionRetry(
        () => p.requestQuestion(questions),
        p.onNotice,
        'AskUserQuestion',
        p.abort.signal,
      );
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    if (toolName === 'Bash') {
      const redirect = redirectFsCommand(String((input as Record<string, unknown>).command ?? ''));
      if (redirect) {
        if (!redirectedCmds.has(redirect.cmd)) {
          redirectedCmds.add(redirect.cmd);
          p.onNotice(`Blocked \`${redirect.cmd}\` in Bash — redirected to the workspace-fs tools.`);
        }
        return { behavior: 'deny', message: redirect.message };
      }
    }
    const req = mapToolToPermission(toolName, input, p.workspaceRoot);
    if (!req) {
      return { behavior: 'allow', updatedInput: input };
    }
    const ok = await withPermissionRetry(
      () => p.requestPermission(req),
      p.onNotice,
      req.title,
      p.abort.signal,
    );
    return ok
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: DENY_MESSAGE };
  };

  const env = buildSubscriptionEnv();
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
    // Route file access through our own tools (lazy summary cache,
    // permission checks, memory tracking, diff-based edit approval) instead
    // of the SDK's built-ins. disallowedTools removes their schemas from the
    // model's context entirely, so it can only see and call the MCP tools
    // below — toolAliases would keep the built-ins' schemas visible and
    // redirect by name only, risking an input-shape mismatch with ours.
    mcpServers: { 'workspace-fs': buildWorkspaceFsServer(p.toolCtx) },
    disallowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob'],
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
  const rateLimitWindows = new Map<string, SubscriptionRateLimitWindow>();

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

      case 'rate_limit_event': {
        const info = message.rate_limit_info;
        if (info.rateLimitType) {
          rateLimitWindows.set(info.rateLimitType, {
            label: RATE_LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType,
            utilization: info.utilization,
            resetsAt: info.resetsAt ? new Date(info.resetsAt).toISOString() : undefined,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return {
    finalText,
    sdkSessionId,
    estValueUsd,
    usage,
    isError,
    errorText,
    numTurns,
    rateLimit: rateLimitWindows.size ? { windows: [...rateLimitWindows.values()] } : undefined,
  };
}

/** Read-only workspace-fs tools the subscription planner may call — mirrors planner.ts's READ_ONLY_TOOLS. */
const READ_ONLY_MCP_TOOLS = new Set([
  'mcp__workspace-fs__read_file',
  'mcp__workspace-fs__glob',
  'mcp__workspace-fs__grep',
  'mcp__workspace-fs__get_diagnostics',
]);

export interface SubscriptionPlanParams {
  prompt: string;
  workspaceRoot: string;
  /** Backs the workspace-fs MCP server; write-shaped tools are denied by canUseTool below, not omitted from the server. */
  toolCtx: ToolContext;
  /** 'sonnet' | 'opus' | 'haiku' — the subscription CLI's model aliases, not API model ids. */
  model: string;
  maxToolCalls: number;
  abort: AbortController;
  onToolUse?: (name: string, detail: string) => void;
}

export interface SubscriptionPlanResult {
  plan: string;
  usage: SubUsage;
  /** Estimated API-equivalent value of the plan run (informational — not billed). */
  estValueUsd: number;
  toolCalls: number;
  /** True if the run hit its turn budget without ever producing a plan. */
  truncated: boolean;
  isError: boolean;
  errorText: string | undefined;
}

/**
 * Subscription-backed counterpart to planner.ts's planTask: runs the same
 * read-only exploration + plan-drafting job through the Agent SDK so it
 * draws from the user's Pro/Max plan instead of API credits. Reuses
 * buildWorkspaceFsServer for the exploration tools but restricts canUseTool
 * to the read-only subset — the planner must never write files.
 */
export async function runSubscriptionPlan(p: SubscriptionPlanParams): Promise<SubscriptionPlanResult> {
  const env = buildSubscriptionEnv();
  const claudeExecutable = await findClaudeExecutable();

  const canUseTool: CanUseTool = async (toolName, input): Promise<PermissionResult> => {
    if (READ_ONLY_MCP_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: 'Planning is read-only — this tool is unavailable during planning.' };
  };

  const options: Options = {
    cwd: p.workspaceRoot,
    model: p.model,
    pathToClaudeCodeExecutable: claudeExecutable,
    maxTurns: p.maxToolCalls + 1,
    abortController: p.abort,
    canUseTool,
    env,
    settingSources: [],
    mcpServers: { 'workspace-fs': buildWorkspaceFsServer(p.toolCtx) },
    disallowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'Bash'],
    systemPrompt: PLAN_SYSTEM,
  };

  let plan = '';
  let toolCalls = 0;
  let estValueUsd = 0;
  let isError = false;
  let errorText: string | undefined;
  let hitMaxTurns = false;
  const usage: SubUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for await (const message of query({ prompt: p.prompt, options }) as AsyncIterable<SDKMessage>) {
    switch (message.type) {
      case 'assistant': {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            toolCalls += 1;
            p.onToolUse?.(block.name, previewToolInput(block.input));
          } else if (block.type === 'text' && message.parent_tool_use_id == null) {
            plan = block.text;
          }
        }
        break;
      }

      case 'result': {
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
          hitMaxTurns = message.subtype === 'error_max_turns';
        } else if (message.is_error) {
          isError = true;
          errorText = message.result;
        } else if (message.result && !plan) {
          plan = message.result;
        }
        break;
      }

      default:
        break;
    }
  }

  return { plan: plan.trim(), usage, estValueUsd, toolCalls, truncated: hitMaxTurns && !plan.trim(), isError, errorText };
}

const UTILITY_SYSTEM_PROMPT =
  'You are a fast, cheap utility model handling one background request for a coding agent. ' +
  'Respond directly and concisely — no tools, no questions, no preamble.';

export interface SubscriptionUtilityParams {
  prompt: string;
  workspaceRoot: string;
  system?: string;
  /** When set, the response is validated against this JSON schema and returned parsed via `structured`. */
  schema?: Record<string, unknown>;
}

export interface SubscriptionUtilityResult {
  text: string;
  structured: unknown;
  usage: SubUsage;
  estValueUsd: number;
  isError: boolean;
  errorText: string | undefined;
}

/**
 * One-shot, toolless subscription call for cheap background utility work
 * (summarizing, classifying, compacting — see haiku.ts) — the Haiku-tier
 * counterpart to runSubscriptionTurn's full agentic loop. Own AbortController
 * since these aren't tied to the user's Cancel button.
 */
export async function runSubscriptionUtility(p: SubscriptionUtilityParams): Promise<SubscriptionUtilityResult> {
  const env = buildSubscriptionEnv();
  const claudeExecutable = await findClaudeExecutable();

  const options: Options = {
    cwd: p.workspaceRoot,
    model: CLASSIFIER_MODEL,
    pathToClaudeCodeExecutable: claudeExecutable,
    maxTurns: 1,
    tools: [],
    abortController: new AbortController(),
    env,
    settingSources: [],
    systemPrompt: p.system ?? UTILITY_SYSTEM_PROMPT,
    ...(p.schema ? { outputFormat: { type: 'json_schema' as const, schema: p.schema } } : {}),
  };

  let text = '';
  let structured: unknown;
  let estValueUsd = 0;
  let isError = false;
  let errorText: string | undefined;
  const usage: SubUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for await (const message of query({ prompt: p.prompt, options }) as AsyncIterable<SDKMessage>) {
    if (message.type !== 'result') {
      continue;
    }
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
    } else {
      text = message.result ?? '';
      structured = (message as any).structured_output;
    }
  }

  return { text, structured, usage, estValueUsd, isError, errorText };
}

export interface HaikuTaskParams {
  /** Undefined when there's no open workspace — the subscription attempt is skipped. */
  workspaceRoot: string | undefined;
  /** Undefined for subscription-only users — the credits fallback is skipped. */
  client: Anthropic | undefined;
  prompt: string;
  schema?: Record<string, unknown>;
  system?: string;
  maxTokens: number;
}

export interface HaikuTaskResult {
  text: string;
  structured: unknown;
  backend: 'subscription' | 'credits';
  usage: SubUsage;
  estValueUsd: number;
}

/**
 * Runs a cheap Haiku-tier background request, preferring the user's
 * subscription (Pro/Max plan, no API credits spent) and falling back to
 * direct API credits only if the subscription is unavailable or fails.
 * Throws if neither path works — callers already handle that with their own
 * graceful degradation (empty summary, recency fallback, etc.).
 */
export async function runHaikuTask(p: HaikuTaskParams): Promise<HaikuTaskResult> {
  if (p.workspaceRoot) {
    try {
      const r = await runSubscriptionUtility({
        prompt: p.prompt,
        workspaceRoot: p.workspaceRoot,
        system: p.system,
        schema: p.schema,
      });
      if (!r.isError) {
        return { text: r.text, structured: r.structured, backend: 'subscription', usage: r.usage, estValueUsd: r.estValueUsd };
      }
    } catch {
      // Subscription unavailable (no CLI, not logged in, transient error) — fall through to credits.
    }
  }

  if (!p.client) {
    throw new Error('Haiku task failed: subscription unavailable and no API key configured.');
  }
  const response = await p.client.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: p.maxTokens,
    ...(p.system ? { system: p.system } : {}),
    ...(p.schema ? { output_config: { format: { type: 'json_schema', schema: p.schema } } } : ({} as any)),
    messages: [{ role: 'user', content: p.prompt }],
  });
  const block = response.content.find((b) => b.type === 'text');
  const text = block && block.type === 'text' ? block.text : '';
  return {
    text,
    structured: p.schema && text ? JSON.parse(text) : undefined,
    backend: 'credits',
    usage: {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    estValueUsd: 0,
  };
}

/**
 * Map Claude Code tool calls onto our permission cards. Returning undefined
 * means "allow silently" (workspace reads, searches, internal bookkeeping).
 * Keys are shared with the credits backend, so "yes, always" answers apply
 * to both.
 */
export function mapToolToPermission(
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
    case 'NotebookEdit': {
      // The only SDK-native edit tool left after disallowedTools — Write/Edit/
      // MultiEdit route through workspace-fs (see buildWorkspaceFsServer),
      // which handles its own diff-based approval via requestEditApproval.
      if (!filePath) {
        return { kind: 'edit', key: 'workspace-edits', title: `${toolName} (unknown path)`, detail: JSON.stringify(input).slice(0, 200) };
      }
      const { abs, isOutside } = outside(filePath);
      if (isOutside) {
        return {
          kind: 'outside-write',
          key: `write:${path.dirname(abs)}`,
          title: 'Edit a file outside the workspace',
          detail: abs,
        };
      }
      return {
        kind: 'edit',
        key: 'workspace-edits',
        title: `Edit ${path.relative(workspaceRoot, abs)}`,
        detail: summarizeEdit(input),
      };
    }
    default:
      // Read/Write/Edit/MultiEdit/Grep/Glob are disallowed (see options
      // above) and never reach here. WebSearch/WebFetch/TodoWrite/Task and
      // other internal tools: read-only or harmless — allow without
      // interrupting the user.
      return undefined;
  }
}

function summarizeEdit(input: Record<string, unknown>): string {
  const one = (s: unknown, max = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  if (typeof i?.path === 'string') {
    return i.path;
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
