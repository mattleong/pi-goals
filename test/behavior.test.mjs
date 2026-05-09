import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { createThreadGoal } from "../goal-core.mjs";
import { createGoalStore } from "../goal-store.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

function tempDir() {
	return mkdtempSync(path.join(tmpdir(), "pi-goal-behavior-"));
}

function runPiGoal(root, command) {
	const messages = Array.isArray(command) ? command : [command];
	return spawnSync(
		"pi",
		[
			"-e",
			".",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--offline",
			"-p",
			...messages,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
			},
		},
	);
}

test("slash-command E2E: /goal creates SQLite goal/checkpoints without consuming an auto-turn before dispatch", { timeout: 120_000 }, () => {
	const root = tempDir();
	try {
		const result = runPiGoal(root, "/goal Behavioral parity --budget 123");
		assert.equal(result.status, 0, result.stderr || result.stdout);

		const db = new DatabaseSync(path.join(root, "sessions", "pi-goal.sqlite"));
		try {
			const rows = db.prepare("SELECT * FROM thread_goals").all();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].objective, "Behavioral parity");
			assert.equal(rows[0].status, "active");
			assert.equal(rows[0].token_budget, 123);

			const metadata = db.prepare("SELECT * FROM pi_goal_metadata WHERE thread_id = ?").get(rows[0].thread_id);
			assert.equal(metadata.autonomous_turns, 0);

			const runtime = db.prepare("SELECT * FROM pi_goal_runtime WHERE thread_id = ?").get(rows[0].thread_id);
			assert.equal(runtime.continuation_state, "idle");

			const events = db.prepare("SELECT event FROM pi_goal_events ORDER BY id ASC").all().map((row) => row.event);
			assert.ok(events.includes("set"));
			assert.ok(events.includes("session_shutdown"));
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("slash-command E2E: objectives can start with command words", { timeout: 120_000 }, () => {
	const root = tempDir();
	try {
		const result = runPiGoal(root, "/goal Complete the docs --budget 12");
		assert.equal(result.status, 0, result.stderr || result.stdout);

		const db = new DatabaseSync(path.join(root, "sessions", "pi-goal.sqlite"));
		try {
			const rows = db.prepare("SELECT * FROM thread_goals").all();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].objective, "Complete the docs");
			assert.equal(rows[0].token_budget, 12);
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("slash-command E2E: same objective updates without replacement prompt", { timeout: 120_000 }, () => {
	const root = tempDir();
	try {
		const result = runPiGoal(root, ["/goal Same objective --budget 10", "/goal Same objective --budget 20"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);

		const db = new DatabaseSync(path.join(root, "sessions", "pi-goal.sqlite"));
		try {
			const rows = db.prepare("SELECT * FROM thread_goals").all();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].objective, "Same objective");
			assert.equal(rows[0].token_budget, 20);
			const notes = db.prepare("SELECT note FROM pi_goal_events ORDER BY id ASC").all().map((row) => row.note);
			assert.ok(notes.includes("Updated existing non-terminal goal with the same objective."));
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("slash-command E2E: completed goals cannot be resumed", { timeout: 120_000 }, () => {
	const root = tempDir();
	try {
		const result = runPiGoal(root, ["/goal Finish me", "/goal complete", "/goal resume"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);

		const db = new DatabaseSync(path.join(root, "sessions", "pi-goal.sqlite"));
		try {
			const rows = db.prepare("SELECT * FROM thread_goals").all();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].objective, "Finish me");
			assert.equal(rows[0].status, "complete");
			const notes = db.prepare("SELECT note FROM pi_goal_events ORDER BY id ASC").all().map((row) => row.note);
			assert.ok(notes.includes("Marked complete by user."));
			assert.ok(!notes.includes("Resumed by user."));
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("slash-command E2E: invalid budget flags are rejected", { timeout: 120_000 }, () => {
	const root = tempDir();
	try {
		const result = runPiGoal(root, "/goal Bad budget --budget nope");
		assert.equal(result.status, 0, result.stderr || result.stdout);

		const db = new DatabaseSync(path.join(root, "sessions", "pi-goal.sqlite"));
		try {
			assert.equal(db.prepare("SELECT COUNT(*) AS count FROM thread_goals").get().count, 0);
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("behavior: budget limit is reported once while turn accounting still finishes", () => {
	const root = tempDir();
	try {
		const store = createGoalStore({ sessionDir: path.join(root, "sessions"), threadId: "thread-budget-once" });
		let goal = store.createGoal({ objective: "Budget once", goalId: "budget-once", tokenBudget: 10, at: 1 });
		goal = store.accountUsage({ tokenDelta: 12, timeDeltaMs: 1_500, expectedGoalId: goal.goalId, at: 2 });
		assert.equal(goal.status, "budget_limited");
		goal = store.accountUsage({ tokenDelta: 0, timeDeltaMs: 0, turnIncrement: 1, expectedGoalId: goal.goalId, at: 3 });
		assert.equal(goal.turnsUsed, 1);
		assert.equal(goal.status, "budget_limited");
		store.saveCheckpoint(goal, { budgetLimitReportedGoalId: goal.goalId }, "budget_limit_reported", "reported once");
		store.saveCheckpoint(goal, { budgetLimitReportedGoalId: goal.goalId }, "account", "later accounting");
		const reports = store.listRecentEvents(10).filter((event) => event.event === "budget_limit_reported");
		assert.equal(reports.length, 1);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("behavior: session checkpoint can hydrate SQLite for branch/fork recovery", () => {
	const root = tempDir();
	try {
		const sessionDir = path.join(root, "sessions");
		const original = createGoalStore({ sessionDir, threadId: "original-thread" });
		const goal = { ...createThreadGoal({ objective: "Branch goal", goalId: "branch-goal", now: 10 }), tokensUsed: 5 };
		const runtime = { continuationState: "idle", lastAccountedTurnMessageTokens: 5 };
		original.saveCheckpoint(goal, runtime, "set", "original branch");
		const checkpoint = original.listRecentEvents(1)[0];
		original.close();

		const forked = createGoalStore({ sessionDir, threadId: "forked-thread" });
		forked.saveCheckpoint(checkpoint.goal, checkpoint.runtime, "session_restore", undefined, { record: false });
		assert.equal(forked.getGoal().objective, "Branch goal");
		assert.equal(forked.getGoal().tokensUsed, 5);
		forked.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
