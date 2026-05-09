# pi-goal

A publishable [pi](https://pi.dev) package that adds a Codex-style persistent `/goal` workflow.

`pi-goal` lets you set a long-running objective, keep it visible in the footer, and let the agent continue working toward it across turns until it is completed, paused, cleared, or budget-limited.

## Install

Requires Node.js 22.5+ because the extension uses `node:sqlite` for Codex-like local persistence.

Use directly from this repository while developing:

```bash
pi -e .
```

Install locally for a project:

```bash
pi install -l ./path/to/pi-goal
```

Install globally from a local checkout:

```bash
pi install ./path/to/pi-goal
```

When published to npm, install with:

```bash
pi install npm:pi-goal
```

## Usage

```text
/goal <objective>
/goal status
/goal pause
/goal resume
/goal clear
/goal advanced
```

Examples:

```text
/goal Implement the feature described in docs/spec.md and keep going until tests pass
/goal Reduce flaky auth tests while keeping the existing auth API stable
/goal pause
/goal resume
/goal clear
```

## Model tools

The extension registers three model-callable tools:

- `get_goal` — inspect the current goal and usage.
- `create_goal` — create a goal only when explicitly requested.
- `update_goal` — mark an existing goal `complete` only.

The tool schemas and JSON result use Codex-compatible camelCase fields where pi can provide them: `goal`, `remainingTokens`, and `completionBudgetReport`. Goal objects include `threadId`, `objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`, `createdAt`, and `updatedAt`.

## Budgets

The normal slash-command surface is Codex-like: `/goal <objective>` treats the entire argument as objective text. It does not parse budget flags. For example, `/goal Task --budget 123` stores the literal objective `Task --budget 123`.

Token budgets can still be set through pi-native advanced controls:

```text
/goal budget <tokens|none>
```

The model-facing `create_goal` tool also supports `token_budget` when a budget is explicitly requested. When counted goal tokens reach the token budget, pi-goal marks the goal `budget_limited`, stops automatic continuation, and sends a hidden wrap-up prompt.

`/goal max-turns <n|none>` is separate: it is an optional pi-only autonomous-turn guard, not a token budget and not part of Codex's normal `/goal <objective>` parsing.

## Behavior

- Uses an authoritative local SQLite database (`pi-goal.sqlite` in pi's session directory) with Codex's `0029_thread_goals.sql` shape, plus separate pi metadata/runtime tables and pi session custom-entry checkpoints under `pi-goal` for branch/export/recovery behavior.
- Adds a footer status indicator while a goal exists.
- Injects goal context while the goal is active.
- Queues hidden follow-up continuation messages while the goal is active and the agent is idle.
- Debounces continuation dispatch and only consumes a pi auto-turn guard count once the continuation is actually sent.
- Persists continuation lock state so reload/resume is less likely to double-queue a continuation.
- Automatically resumes active goals on session start/resume and shows a Codex-like `Resume goal` / `Leave paused` selector for paused goals.
- Setting a goal while any goal already exists shows a Codex-like `Replace current goal` / `Cancel` selector; if the confirmed objective is the same non-terminal goal, usage is preserved by the persistence layer.
- Checkpoints accounting on session switch, fork, shutdown, compaction, tree navigation, tool results, assistant messages, and turn end.
- Pauses active goals after aborted turns.
- Sends a hidden budget-limit wrap-up prompt when a budget is reached.
- Tracks approximate turn count, elapsed time, and token usage using non-cached input plus output tokens when available, with runtime baselines to avoid double-counting across assistant-message and turn-end accounting.
- Suppresses repeated automatic continuation when a continuation turn makes no tool-observable autonomous progress.
- Provides advanced `/goal history [n]`, `/goal debug`, `/goal export`, `/goal api`, `/goal branch-status`, and `/goal panel [on|off]` commands for auditing the persisted event log, event payloads, branch semantics, and a richer TUI panel.
- Uses Codex's continuation and budget-limit prompt wording as closely as pi's extension API allows.
- Enforces Codex's 4,000-character objective cap and budget validation wording.
- Leaves the pi-specific auto-turn guard disabled by default for closer Codex parity. Set `PI_GOAL_MAX_AUTONOMOUS_TURNS` or use advanced `/goal max-turns N` to enable it; reaching the guard pauses the goal rather than marking it `budgetLimited`.

## Advanced/debug commands

These are intentionally hidden from normal `/goal help` output to keep the main command surface closer to Codex:

```text
/goal complete
/goal budget <tokens|none>
/goal max-turns <n|none>
/goal history [n]
/goal debug
/goal export
/goal api <thread_goal_get|thread_goal_set|thread_goal_clear> [json]
/goal branch-status
/goal panel [on|off]
```

- `/goal budget <tokens|none>` updates the pi goal token budget without adding a non-Codex flag to normal `/goal <objective>` parsing.
- `/goal export` prints a goal-updated event payload and tool response for debugging.
- `/goal api <thread_goal_get|thread_goal_set|thread_goal_clear> [json]` is a local API-style shim for debugging and tests.
- `/goal branch-status` explains the current session id/file/leaf and recent goal-affecting branch lifecycle events.
- `/goal panel` toggles a richer goal panel above the editor.

## Branch and fork semantics

SQLite is the runtime source of truth. pi-goal applies Codex-compatible migration `0029_thread_goals.sql`, then pi-specific migrations for runtime/accounting metadata and events. Atomic SQL transitions use expected goal IDs for status, budget, accounting, and continuation updates where possible.

pi-goal also appends compact `pi-goal` session checkpoints after each mutation. On session start/resume/fork/tree navigation, the extension hydrates the SQLite row for the active pi thread from the latest checkpoint on that branch, then continues using SQLite authoritatively.

Forking or tree navigation therefore carries goal state present at the fork point, then each branch can diverge independently. The extension checkpoints usage and clears pending continuation locks before switch, fork, compaction, shutdown, and tree navigation to reduce stale autonomous work after branch changes.

## How close is this to Codex `/goal`?

This is a pi-native behavioral approximation, not a port of Codex internals. It mirrors the user-facing lifecycle, model tools, durable goal storage, continuation steering, and budget behavior, but pi extensions cannot hook into the exact same core scheduler, app-server notifications, or token accounting that Codex uses.

Closest matches:

- `/goal` lifecycle commands.
- `active`, `paused`, `budgetLimited`, and `complete` model-facing statuses (`budget_limited` internally for pi persistence).
- `get_goal`, `create_goal`, and `update_goal` tools.
- `update_goal` can only complete a goal.
- Codex-compatible model tool names, descriptions, validation wording, and camelCase result shape.
- Hidden continuation and budget-limit prompts with Codex's completion-audit guidance.
- Replacement confirmation is shown when a goal already exists, and confirmed same-objective updates preserve usage instead of replacing the goal.
- Active goals continue after session restore; paused goals can prompt to resume.
- Interrupted/aborted turns pause the active goal.
- Token-budget exhaustion is the only automatic `budgetLimited` path; pi's optional auto-turn guard pauses instead.
- Session lifecycle checkpoints, branch-status reporting, event export, and event history for debugging/audit.

Known differences:

- Persistence uses a package-local SQLite database with Codex's `thread_goals` schema, not Codex's own state DB implementation or migrations table.
- Continuation scheduling is extension-level follow-up messaging, not Codex core runtime scheduling.
- Token/time accounting is approximate and extension-level, not Codex core accounting.
- Interrupt/resume behavior is approximated but not as deeply integrated as Codex.
- Automatic continuation uses pi follow-up messages and persisted extension locks rather than Codex core scheduler locks.
- pi-specific advanced `/goal budget`, `/goal max-turns`, and auto-turn counters are optional extension controls, not Codex CLI slash-command fields.
- There is no app-server JSON-RPC goal API; `/goal export` only prints a Codex-like event payload for debugging.
- Requires Node.js with `node:sqlite` (Node 22.5+).

## Package layout

```text
package.json        # pi package manifest
index.ts            # extension entry point
goal-core.mjs       # testable pure goal helpers
goal-store.mjs      # SQLite persistence layer
migrations/         # Codex-compatible and pi-specific SQL migrations
README.md
LICENSE
test/               # parity and integration tests
```

The package manifest declares:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Development

Run behavioral E2E, parity, core state-transition, integration, SQLite store, and pi runtime smoke tests:

```bash
npm test
```

Validate package discovery:

```bash
pi -e . --list-models
```

Create an npm tarball preview:

```bash
npm pack --dry-run
```

Run the full validation workflow:

```bash
npm run validate
```
