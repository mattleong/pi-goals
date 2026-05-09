import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createThreadGoal } from "../goal-core.mjs";
import { createGoalStore, defaultGoalDbPath } from "../goal-store.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

function tempSessionDir() {
	return mkdtempSync(path.join(tmpdir(), "pi-goal-store-"));
}

const defaultRuntime = {
	continuationState: "idle",
	continuationId: null,
	continuationGoalId: null,
	continuationUpdatedAt: null,
	continuationStartEntryCount: null,
	continuationRequestedEntryCount: null,
	autoContinuationSuppressed: false,
	budgetLimitReportedGoalId: null,
	lastAccountedTurnMessageTokens: 0,
	currentTurnIndex: null,
	accountingActiveGoalId: null,
	accountingTurnIndex: null,
	activeTurnStartedAt: null,
	wallClockLastAccountedAt: null,
};

test("SQLite store persists Codex-like thread_goals plus pi metadata/runtime", () => {
	const sessionDir = tempSessionDir();
	try {
		const store = createGoalStore({ sessionDir, threadId: "thread-store" });
		const goal = {
			...createThreadGoal({ objective: "Persist me", goalId: "goal-store", tokenBudget: 500, now: 1000 }),
			tokensUsed: 123,
			timeUsedMs: 45_900,
			turnsUsed: 2,
			autonomousTurns: 1,
		};
		const runtime = {
			...defaultRuntime,
			continuationState: "queued",
			continuationId: "cont-1",
			continuationGoalId: "goal-store",
			continuationUpdatedAt: 2000,
			continuationRequestedEntryCount: 7,
			lastAccountedTurnMessageTokens: 42,
			currentTurnIndex: 3,
		};
		store.saveCheckpoint(goal, runtime, "set", "created in test");
		store.close();

		const reopened = createGoalStore({ sessionDir, threadId: "thread-store" });
		assert.deepEqual(reopened.getSnapshot(), {
			goal: { ...goal, timeUsedMs: 45_000 },
			runtime,
		});
		assert.equal(reopened.dbPath, defaultGoalDbPath(sessionDir));
		assert.equal(reopened.listRecentEvents(10).at(-1).event, "set");
		reopened.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("SQLite store can clear a goal while retaining runtime and event history", () => {
	const sessionDir = tempSessionDir();
	try {
		const store = createGoalStore({ sessionDir, threadId: "thread-clear" });
		store.saveCheckpoint(createThreadGoal({ objective: "Clear me", goalId: "clear" }), {}, "set");
		store.saveCheckpoint(null, { continuationState: "idle" }, "clear", "cleared in test");
		assert.equal(store.getGoal(), null);
		assert.equal(store.getRuntime().continuationState, "idle");
		assert.deepEqual(store.listRecentEvents(2).map((event) => event.event), ["set", "clear"]);
		store.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("SQLite store applies Codex-compatible migrations", () => {
	const sessionDir = tempSessionDir();
	try {
		const store = createGoalStore({ sessionDir, threadId: "thread-migrations" });
		store.createGoal({ objective: "Migrated", goalId: "migrated", tokenBudget: 99, at: 123 });
		assert.equal(store.getGoal().objective, "Migrated");
		store.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("atomic SQL transitions preserve same-objective usage and reset replacement usage", () => {
	const sessionDir = tempSessionDir();
	try {
		const store = createGoalStore({ sessionDir, threadId: "thread-atomic" });
		store.createGoal({ objective: "Same", goalId: "same", tokenBudget: 100, at: 1 });
		store.accountUsage({ tokenDelta: 40, timeDeltaMs: 2_000, turnIncrement: 1, expectedGoalId: "same", at: 2 });
		const same = store.setGoal({ objective: "Same", status: "active", tokenBudgetProvided: true, tokenBudget: 200, at: 3 });
		assert.equal(same.goalId, "same");
		assert.equal(same.tokensUsed, 40);
		assert.equal(same.timeUsedMs, 2_000);
		assert.equal(same.tokenBudget, 200);

		const replaced = store.setGoal({ objective: "Different", status: "active", tokenBudgetProvided: false, at: 4 });
		assert.notEqual(replaced.goalId, "same");
		assert.equal(replaced.tokensUsed, 0);
		assert.equal(replaced.timeUsedMs, 0);
		store.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("atomic accounting budget-limits with expected goal id", () => {
	const sessionDir = tempSessionDir();
	try {
		const store = createGoalStore({ sessionDir, threadId: "thread-budget" });
		store.createGoal({ objective: "Budget", goalId: "budget", tokenBudget: 10, at: 1 });
		const limited = store.accountUsage({ tokenDelta: 11, expectedGoalId: "budget", at: 2 });
		assert.equal(limited.status, "budget_limited");
		assert.throws(() => store.setStatus({ status: "complete", expectedGoalId: "wrong" }), /no goal exists/);
		store.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("SQLite store keeps completed goals terminal until replacement or clear", () => {
	const sessionDir = tempSessionDir();
	try {
		const store = createGoalStore({ sessionDir, threadId: "thread-complete-terminal" });
		store.createGoal({ objective: "Complete", goalId: "complete", at: 1 });
		store.setStatus({ status: "complete", expectedGoalId: "complete", at: 2 });
		assert.throws(() => store.setStatus({ status: "active", expectedGoalId: "complete", at: 3 }), /cannot resume a completed goal/);
		assert.equal(store.getGoal().status, "complete");
		store.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});

test("SQLite store patches prototype runtime tables missing accounting baseline columns", () => {
	const sessionDir = tempSessionDir();
	try {
		const dbPath = defaultGoalDbPath(sessionDir);
		const db = new DatabaseSync(dbPath);
		db.exec(`
CREATE TABLE pi_goal_migrations (name TEXT PRIMARY KEY, applied_at_ms INTEGER NOT NULL);
CREATE TABLE threads (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete')),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE pi_goal_metadata (
    thread_id TEXT PRIMARY KEY,
    goal_id TEXT,
    max_autonomous_turns INTEGER,
    turns_used INTEGER NOT NULL DEFAULT 0,
    autonomous_turns INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE pi_goal_runtime (
    thread_id TEXT PRIMARY KEY,
    continuation_state TEXT NOT NULL DEFAULT 'idle',
    continuation_id TEXT,
    continuation_goal_id TEXT,
    continuation_updated_at_ms INTEGER,
    continuation_start_entry_count INTEGER,
    auto_continuation_suppressed INTEGER NOT NULL DEFAULT 0,
    budget_limit_reported_goal_id TEXT,
    last_accounted_turn_message_tokens INTEGER NOT NULL DEFAULT 0,
    current_turn_index INTEGER,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE pi_goal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    event TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    goal_json TEXT,
    runtime_json TEXT,
    note TEXT
);
INSERT INTO pi_goal_migrations(name, applied_at_ms) VALUES ('0028_threads_compat.sql', 1), ('0029_thread_goals.sql', 1), ('0030_pi_goal_runtime.sql', 1);
`);
		db.close();

		const store = createGoalStore({ sessionDir, threadId: "thread-upgrade" });
		store.saveCheckpoint(createThreadGoal({ objective: "Upgrade", goalId: "upgrade" }), {
			accountingActiveGoalId: "upgrade",
			activeTurnStartedAt: 123,
		}, "set");
		assert.equal(store.getRuntime().accountingActiveGoalId, "upgrade");
		store.close();
	} finally {
		rmSync(sessionDir, { recursive: true, force: true });
	}
});
