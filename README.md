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

## Tools available to the model

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `run_command` (asks for confirmation unless `claudeCoder.autoApproveCommands` is on), `get_diagnostics` (VS Code language-server errors — the agent is instructed to verify its edits with it).

## Settings

- `claudeCoder.modelLadder` — escalation ladder, cheapest first
- `claudeCoder.autoTaskDetection` — Haiku task/complexity classifier on each prompt
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
```

## Cache discipline rules (don't break these)

1. `SYSTEM_PROMPT` must stay byte-identical across requests — no timestamps, no interpolation. Dynamic context goes in the first user message.
2. `TOOL_DEFINITIONS` order and content must not change mid-session.
3. Model switches always go through a session reset (`SessionManager.reset`), never in-place.

## Roadmap (not built yet)

- Server-side compaction / context editing for very long single tasks (beta headers `compact-2026-01-12`, `context-management-2025-06-27`)
- Automatic escalation on failure signals (diagnostics still red / tests failing after N rounds) instead of the manual Escalate button
- Diff preview before applying file edits
- Markdown rendering in the chat webview
