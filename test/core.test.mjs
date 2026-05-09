import assert from "node:assert/strict";
import test from "node:test";
import {
	applyTokenBudget,
	budgetLimitPrompt,
	completionBudgetReport,
	continuationPrompt,
	createThreadGoal,
	goalToToolPayload,
	messageTokenDelta,
	messageTokenUsage,
	readDefaultMaxAutonomousTurns,
	threadGoalUpdatedEvent,
} from "../goal-core.mjs";

test("goal tool payload matches Codex-style camelCase shape", () => {
	const goal = {
		...createThreadGoal({ objective: "Ship feature", goalId: "g1", tokenBudget: 1000, now: 10 }),
		tokensUsed: 250,
		timeUsedMs: 12_300,
	};
	assert.deepEqual(goalToToolPayload(goal, "thread-1"), {
		goal: {
			threadId: "thread-1",
			objective: "Ship feature",
			status: "active",
			tokenBudget: 1000,
			tokensUsed: 250,
			timeUsedSeconds: 12,
			createdAt: 10,
			updatedAt: 10,
		},
		remainingTokens: 750,
		completionBudgetReport: null,
	});
});

test("completion report is included only when requested for complete goals", () => {
	const goal = {
		...createThreadGoal({ objective: "Done", goalId: "g2", tokenBudget: 100, now: 1 }),
		status: "complete",
		tokensUsed: 80,
		timeUsedMs: 3_000,
		updatedAt: 2,
	};
	assert.equal(completionBudgetReport(goal), "Goal achieved. Report final budget usage to the user: tokens used: 80 of 100; time used: 3 seconds.");
	assert.equal(goalToToolPayload(goal, "thread-1").completionBudgetReport, null);
	assert.equal(
		goalToToolPayload(goal, "thread-1", { includeCompletionBudgetReport: true }).completionBudgetReport,
		"Goal achieved. Report final budget usage to the user: tokens used: 80 of 100; time used: 3 seconds.",
	);
});

test("cached input is excluded from goal token usage and turn-end deltas avoid double counting", () => {
	const message = { usage: { input: 100, cacheRead: 40, output: 25 } };
	assert.equal(messageTokenUsage(message), 85);
	assert.deepEqual(messageTokenDelta(message, 0), { delta: 85, observed: 85 });
	assert.deepEqual(messageTokenDelta(message, 85), { delta: 0, observed: 85 });
	assert.deepEqual(messageTokenDelta({ usage: { input: 110, cacheRead: 40, output: 30 } }, 85), {
		delta: 15,
		observed: 100,
	});
});

test("token budget, not pi auto-turn guard, produces budget_limited", () => {
	const goal = { ...createThreadGoal({ objective: "Stay in budget", tokenBudget: 10 }), tokensUsed: 11 };
	assert.equal(applyTokenBudget(goal).status, "budget_limited");
	assert.equal(readDefaultMaxAutonomousTurns({}), null);
	assert.equal(readDefaultMaxAutonomousTurns({ PI_GOAL_MAX_AUTONOMOUS_TURNS: "7" }), 7);
});

test("prompts preserve objective escaping", () => {
	const goal = createThreadGoal({ objective: "Fix <unsafe> & verify" });
	assert.match(continuationPrompt(goal), /Fix &lt;unsafe&gt; &amp; verify/);
	assert.match(budgetLimitPrompt(goal), /Fix &lt;unsafe&gt; &amp; verify/);
});

test("Codex-like ThreadGoalUpdatedEvent payload can be exported", () => {
	const goal = createThreadGoal({ objective: "Export event", goalId: "g3", now: 123 });
	assert.deepEqual(threadGoalUpdatedEvent(goal, "thread-1", "turn-2"), {
		threadId: "thread-1",
		turnId: "turn-2",
		goal: {
			threadId: "thread-1",
			objective: "Export event",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 123,
			updatedAt: 123,
		},
	});
});
