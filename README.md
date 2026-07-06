# Claude Coder

A cost-aware Claude coding agent as a VS Code extension, talking to the Anthropic API directly. Design goals: access to any model (including Fable 5) and minimal token spend through prompt caching, automatic task-scoped sessions, and model escalation.

## Run it

1. `npm install && npm run build`
2. Open this folder in VS Code and press **F5** (launches an Extension Development Host).
3. In the dev host window, open any project folder, then open the **Claude Coder** icon in the activity bar.
4. Set your key: `Ctrl+Shift+P` → **Claude Coder: Set API Key** (stored in VS Code secret storage; `ANTHROPIC_API_KEY` env var also works).
5. Chat. The status bar (bottom right) shows the current model and running cost — click it for the full breakdown.

## How it saves tokens

| Mechanism | Where | Effect |
|---|---|---|
| Prompt caching | `src/agent/loop.ts`, `src/agent/prompt.ts` | Frozen system prompt + stable tool list + a cache breakpoint moved to the conversation tail every request. Repeated context bills at ~0.1×. Check the hit rate in **Show Session Costs** — it should be high from turn 2 onward. |
| Task-scoped sessions | `src/controller.ts` (`routePrompt`) | Every prompt is classified by a ~$0.0005 Haiku call: `same` task or `new`. A new task archives the session and starts a fresh, short (cheap) one. Complexity rating (`trivial`/`standard`/`hard`) sets the `effort` level (low/high/xhigh). |
| Model escalation | `src/controller.ts` (`escalate`) | Ladder: Sonnet 5 → Opus 4.8 → Fable 5 (configurable). Escalating **restarts the task on a fresh session** seeded with a summary of the failed attempt — continuing the old transcript on a new model would re-pay the whole history uncached. Fable requests opt into server-side refusal fallback to Opus. |
| Effort control | `src/agent/models.ts` | Output tokens cost 5× input; lower effort produces fewer of them for routine work. |
| Context growth warning | `src/controller.ts` | Warns when a request's input passes `compactionThresholdTokens` (default 100k) so you reset instead of dragging a huge transcript. |
| Local memory | `src/agent/memory.ts`, `src/agent/tools.ts` | Per-workspace JSON store (in VS Code's per-project storage dir) of file read hashes and an edit history. Re-reading an unchanged file already sent in full this session returns a short "unchanged" notice instead of the whole file again. Every `write_file`/`edit_file` is logged; a short digest of recent changes is injected into each new task's first message so it doesn't have to rediscover project state via tool calls. Inspect with **Claude Coder: Show Project Memory**. |
| Plan/implement split | `src/agent/planner.ts`, `src/controller.ts` (`planIfNeeded`) | Standard/hard tasks get a short, tool-free plan from the reasoning tier (Opus for standard, Fable for hard — `claudeCoder.planningModelLadder`) capped at `claudeCoder.planningMaxTokens` output tokens. The plan rides into the session's first message; Sonnet then does all the actual tool-calling implementation at low/high effort. Trivial tasks skip planning entirely. |
| Thinking reserved for the reasoning tier | `src/agent/models.ts` (`supportsAdaptiveThinking`) | Only Opus/Fable get extended thinking. Sonnet — doing mechanical implementation off an already-made plan — never spends thinking tokens, which are billed as output at the same 5x rate as everything else. |
| Prompt compression (opt-in) | `src/agent/compressor.ts` | Haiku rewrite of long, prose-heavy prompts (pasted logs/specs) before they hit the expensive model, keeping requirements/errors/code verbatim and cutting filler. Off by default (`claudeCoder.compressLongPrompts`) since it rewrites your own wording — only kicks in above `compressionThresholdChars`. |
| Auto-compaction | `src/agent/compactor.ts`, `controller.ts` (`compactIfNeeded`) | Local, cheap (Haiku) stand-in for server-side compaction. Once a session's input passes `compactionThresholdTokens`, the transcript is summarized and replaced with the summary — same session, same cost totals, but the next turn is small again instead of resending a huge history. Disable with `claudeCoder.autoCompact` to get the old "just warn" behavior back. |

## Tools available to the model

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `run_command` (asks for confirmation unless `claudeCoder.autoApproveCommands` is on), `get_diagnostics` (VS Code language-server errors — the agent is instructed to verify its edits with it).

## Settings

- `claudeCoder.modelLadder` — escalation ladder, cheapest first
- `claudeCoder.autoTaskDetection` — Haiku task/complexity classifier on each prompt
- `claudeCoder.planningEnabled` — draft a plan on Opus/Fable before Sonnet implements (standard/hard tasks only)
- `claudeCoder.planningModelLadder` — planning model by complexity, cheapest-reasoning first
- `claudeCoder.planningMaxTokens` — output cap on the planning call
- `claudeCoder.compressLongPrompts` — Haiku-shrink long pasted prompts before sending (off by default)
- `claudeCoder.compressionThresholdChars` — only compress prompts longer than this
- `claudeCoder.autoCompact` — Haiku-summarize a session's transcript instead of just warning when it grows large
- `claudeCoder.compactionMaxTokens` — output cap on the compaction summary
- `claudeCoder.autoApproveCommands` — skip the shell-command confirmation (risky)
- `claudeCoder.maxTokens` — per-response output cap (streamed)
- `claudeCoder.compactionThresholdTokens` — context-size warning threshold

## Code map

```
src/extension.ts        activation, command registration
src/controller.ts       orchestration: routing, escalation, costs, status bar
src/chat/provider.ts    chat webview (media/chat.js + chat.css are the UI)
src/agent/loop.ts       streaming agent loop, tool rounds, cache breakpoints
src/agent/tools.ts      tool schemas + local executors (path-sandboxed)
src/agent/session.ts    Session / SessionManager, escalation carry-over
src/agent/classifier.ts Haiku task/complexity classifier (structured output)
src/agent/models.ts     pricing table, cost math, effort mapping
src/agent/prompt.ts     frozen system prompt (never edit per-request!)
src/agent/memory.ts     persistent per-workspace read-hash cache + change history
src/agent/planner.ts    one-off tool-free planning call on the reasoning tier (Opus/Fable)
src/agent/compressor.ts Haiku rewrite that shrinks long prose-heavy prompts (opt-in)
src/agent/compactor.ts  Haiku summary that replaces a grown transcript (auto-compaction)
```

## Cache discipline rules (don't break these)

1. `SYSTEM_PROMPT` must stay byte-identical across requests — no timestamps, no interpolation. Dynamic context goes in the first user message.
2. `TOOL_DEFINITIONS` order and content must not change mid-session.
3. Model switches always go through a session reset (`SessionManager.reset`), never in-place.

## Roadmap (not built yet)

- Server-side compaction / context editing for very long single tasks (beta headers `compact-2026-01-12`, `context-management-2025-06-27`) — would replace the local Haiku-based `autoCompact` with the API's own, likely better, summarization
- Automatic escalation on failure signals (diagnostics still red / tests failing after N rounds) instead of the manual Escalate button
- Diff preview before applying file edits
- Markdown rendering in the chat webview
