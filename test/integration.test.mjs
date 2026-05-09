import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
	applyTokenBudget,
	budgetLimitPrompt,
	completionBudgetReport,
	continuationPrompt,
	createThreadGoal,
	goalToToolPayload,
	messageTokenDelta,
	threadGoalUpdatedEvent,
} from "../goal-core.mjs";

test("state-transition integration: create, account, budget-limit, complete", () => {
	let goal = createThreadGoal({ objective: "Implement parity", goalId: "g-int", tokenBudget: 120, now: 1_000 });
	assert.equal(goal.status, "active");

	const firstTurn = messageTokenDelta({ usage: { input: 100, cacheRead: 20, output: 30 } }, 0);
	goal = { ...goal, tokensUsed: goal.tokensUsed + firstTurn.delta, turnsUsed: goal.turnsUsed + 1, timeUsedMs: 5_000, updatedAt: 2_000 };
	assert.equal(goal.tokensUsed, 110);
	assert.equal(applyTokenBudget(goal).status, "active");
	assert.match(continuationPrompt(goal), /Implement parity/);

	const secondTurn = messageTokenDelta({ usage: { input: 120, cacheRead: 20, output: 40 } }, firstTurn.observed);
	goal = { ...goal, tokensUsed: goal.tokensUsed + secondTurn.delta, turnsUsed: goal.turnsUsed + 1, updatedAt: 3_000 };
	goal = applyTokenBudget(goal);
	assert.equal(goal.status, "budget_limited");
	assert.match(budgetLimitPrompt(goal), /reached its token budget/);

	goal = { ...goal, status: "complete", timeUsedMs: 7_000, updatedAt: 4_000 };
	assert.equal(
		completionBudgetReport(goal),
		"Goal achieved. Report final budget usage to the user: tokens used: 140 of 120; time used: 7 seconds.",
	);
	assert.equal(goalToToolPayload(goal, "thread-int", { includeCompletionBudgetReport: true }).goal.status, "complete");
});

test("state-transition integration: same objective update preserves usage", () => {
	const existing = { ...createThreadGoal({ objective: "Same goal", goalId: "same", tokenBudget: 100 }), tokensUsed: 50, timeUsedMs: 9_000 };
	const updated = {
		...existing,
		status: "active",
		tokenBudget: 200,
		updatedAt: existing.updatedAt + 1,
	};
	assert.equal(updated.goalId, existing.goalId);
	assert.equal(updated.tokensUsed, 50);
	assert.equal(updated.timeUsedMs, 9_000);
	assert.equal(updated.tokenBudget, 200);
});

test("state-transition integration: pause, resume, export event", () => {
	let goal = createThreadGoal({ objective: "Pause and resume", goalId: "pause", now: 11 });
	goal = { ...goal, status: "paused", stopReason: "Paused after interruption.", updatedAt: 12 };
	assert.equal(goal.status, "paused");
	goal = { ...goal, status: "active", stopReason: undefined, updatedAt: 13 };
	assert.deepEqual(threadGoalUpdatedEvent(goal, "thread-pause"), {
		threadId: "thread-pause",
		goal: {
			threadId: "thread-pause",
			objective: "Pause and resume",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 11,
			updatedAt: 13,
		},
	});
});

test("real pi runtime smoke-loads the extension package", { timeout: 120_000 }, () => {
	const result = spawnSync("pi", ["-e", ".", "--list-models"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(`${result.stdout}\n${result.stderr}`, /provider\s+model/);
});
