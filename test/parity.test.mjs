import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../goal-core.mjs", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("model tool schema and output stay close to Codex", () => {
	assert.match(source, /name: "get_goal"/);
	assert.match(source, /name: "create_goal"/);
	assert.match(source, /name: "update_goal"/);
	assert.match(source, /registerMessageRenderer<GoalToolRenderDetails>/);
	assert.match(source, /case "get_goal"/);
	assert.match(source, /case "create_goal"/);
	assert.match(source, /case "update_goal"/);
	assert.match(source, /token_budget: Type\.Optional\(Type\.Integer/);
	assert.doesNotMatch(source, /max_autonomous_turns/);
	assert.match(coreSource, /remainingTokens/);
	assert.match(coreSource, /completionBudgetReport/);
	assert.doesNotMatch(source + coreSource, /remaining_tokens/);
	assert.doesNotMatch(source + coreSource, /completion_budget_report/);
});

test("continuation prompt preserves Codex completion-audit requirements", () => {
	assert.match(coreSource, /Continue working toward the active thread goal\./);
	assert.match(coreSource, /Build a prompt-to-artifact checklist/);
	assert.match(coreSource, /Do not accept proxy signals as completion by themselves/);
	assert.match(coreSource, /If the objective is achieved, call update_goal with status "complete"/);
	assert.match(coreSource, /Do not call update_goal unless the goal is complete/);
});

test("budget-limit prompt follows Codex token-budget behavior", () => {
	assert.match(coreSource, /The active thread goal has reached its token budget\./);
	assert.match(coreSource, /The system has marked the goal as budget_limited/);
	assert.match(coreSource, /do not start new substantive work for this goal/);
});

test("pi auto-turn guard is hidden by default and pauses instead of budget-limiting", () => {
	assert.match(source, /const DEFAULT_MAX_AUTONOMOUS_TURNS = core\.readDefaultMaxAutonomousTurns\(\);/);
	assert.match(coreSource, /if \(!raw \|\| \/\^\(none\|off\|false\|0\)\$\/i\.test\(raw\)\) return null;/);
	assert.match(source, /markStatus\("paused", "status", "Pi automatic continuation guard reached\."\)/);
	assert.doesNotMatch(source, /Automatic continuation turn budget reached/);
});

test("Codex-like selectors are documented and implemented", () => {
	assert.match(source, /"Replace current goal", "Cancel"/);
	assert.match(source, /"Resume goal", "Leave paused"/);
	assert.match(readme, /Replace current goal` \/ `Cancel` selector/);
	assert.match(readme, /Resume goal` \/ `Leave paused` selector/);
});

test("advanced pi-only commands are hidden from normal help", () => {
	assert.match(source, /if \(args === "advanced"\)/);
	assert.match(source, /Advanced\/debug goal commands/);
	assert.doesNotMatch(readme.match(/```text\n([\s\S]*?)```/)?.[1] ?? "", /debug|max-turns|complete|history/);
});

test("extension tolerates older SQLite store objects through compatibility helpers", () => {
	assert.match(source, /function storeSetGoal/);
	assert.doesNotMatch(source, /ensureGoalStore\(ctx\)\.setGoal/);
	assert.doesNotMatch(source, /ensureGoalStore\(ctx\)\.createGoal/);
	assert.doesNotMatch(source, /ensureGoalStore\(ctx\)\.setStatus/);
	assert.doesNotMatch(source, /ensureGoalStore\(ctx\)\.setBudget/);
	assert.doesNotMatch(source, /ensureGoalStore\(ctx\)\.clearGoal/);
});

test("development validation workflow is present", () => {
	assert.equal(packageJson.pi.extensions[0], "./index.ts");
	assert.equal(packageJson.scripts.test, "node --test test/*.test.mjs");
	assert.match(packageJson.scripts["smoke:pi"], /pi -e \. --list-models/);
	assert.match(packageJson.scripts.validate, /pack:dry/);
	assert.ok(packageJson.files.includes("test"));
	assert.ok(packageJson.files.includes("goal-core.mjs"));
	assert.ok(packageJson.files.includes("goal-store.mjs"));
	assert.ok(packageJson.files.includes("migrations"));
	assert.equal(packageJson.engines.node, ">=22.5");
});
