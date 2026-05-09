import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const DB_FILENAME = "pi-goal.sqlite";
const MIGRATIONS = [
	"0028_threads_compat.sql",
	"0029_thread_goals.sql",
	"0030_pi_goal_runtime.sql",
];

function loadSqlite() {
	try {
		return require("node:sqlite");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`pi-goal SQLite persistence requires a Node.js runtime with node:sqlite (Node 22.5+). Current runtime could not load node:sqlite: ${message}`,
		);
	}
}

function nowMs() {
	return Date.now();
}

function migrationSql(name) {
	return readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
}

function intOrNull(value) {
	return value === undefined || value === null ? null : Math.trunc(Number(value));
}

function boolToInt(value) {
	return value ? 1 : 0;
}

function intToBool(value) {
	return Boolean(value);
}

function serialize(value) {
	return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value) {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function runtimeWithDefaults(runtime = {}) {
	return {
		continuationState: runtime.continuationState ?? "idle",
		continuationId: runtime.continuationId ?? null,
		continuationGoalId: runtime.continuationGoalId ?? null,
		continuationUpdatedAt: runtime.continuationUpdatedAt ?? null,
		continuationStartEntryCount: runtime.continuationStartEntryCount ?? null,
		continuationRequestedEntryCount: runtime.continuationRequestedEntryCount ?? null,
		autoContinuationSuppressed: Boolean(runtime.autoContinuationSuppressed),
		budgetLimitReportedGoalId: runtime.budgetLimitReportedGoalId ?? null,
		lastAccountedTurnMessageTokens: runtime.lastAccountedTurnMessageTokens ?? 0,
		currentTurnIndex: runtime.currentTurnIndex ?? null,
		accountingActiveGoalId: runtime.accountingActiveGoalId ?? null,
		accountingTurnIndex: runtime.accountingTurnIndex ?? null,
		activeTurnStartedAt: runtime.activeTurnStartedAt ?? null,
		wallClockLastAccountedAt: runtime.wallClockLastAccountedAt ?? null,
	};
}

function goalFromRows(goalRow, metaRow) {
	if (!goalRow) return null;
	return {
		goalId: goalRow.goal_id,
		objective: goalRow.objective,
		status: goalRow.status,
		tokenBudget: goalRow.token_budget ?? null,
		maxAutonomousTurns: metaRow?.max_autonomous_turns ?? null,
		tokensUsed: goalRow.tokens_used,
		turnsUsed: metaRow?.turns_used ?? 0,
		autonomousTurns: metaRow?.autonomous_turns ?? 0,
		timeUsedMs: Math.max(0, goalRow.time_used_seconds ?? 0) * 1000,
		createdAt: goalRow.created_at_ms,
		updatedAt: goalRow.updated_at_ms,
		...(metaRow?.stop_reason ? { stopReason: metaRow.stop_reason } : {}),
	};
}

function runtimeFromRow(row) {
	if (!row) return runtimeWithDefaults();
	return runtimeWithDefaults({
		continuationState: row.continuation_state,
		continuationId: row.continuation_id,
		continuationGoalId: row.continuation_goal_id,
		continuationUpdatedAt: row.continuation_updated_at_ms,
		continuationStartEntryCount: row.continuation_start_entry_count,
		continuationRequestedEntryCount: row.continuation_requested_entry_count,
		autoContinuationSuppressed: intToBool(row.auto_continuation_suppressed),
		budgetLimitReportedGoalId: row.budget_limit_reported_goal_id,
		lastAccountedTurnMessageTokens: row.last_accounted_turn_message_tokens,
		currentTurnIndex: row.current_turn_index,
		accountingActiveGoalId: row.accounting_active_goal_id,
		accountingTurnIndex: row.accounting_turn_index,
		activeTurnStartedAt: row.active_turn_started_at_ms,
		wallClockLastAccountedAt: row.wall_clock_last_accounted_at_ms,
	});
}

function eventFromRow(row) {
	return {
		version: 2,
		event: row.event,
		at: row.at_ms,
		goal: parseJson(row.goal_json),
		runtime: parseJson(row.runtime_json) ?? undefined,
		note: row.note ?? undefined,
	};
}

export function defaultGoalDbPath(sessionDir) {
	return path.join(sessionDir, DB_FILENAME);
}

export function createGoalStore({ sessionDir, threadId, dbPath = defaultGoalDbPath(sessionDir) }) {
	if (!sessionDir) throw new Error("createGoalStore requires sessionDir");
	if (!threadId) throw new Error("createGoalStore requires threadId");
	mkdirSync(path.dirname(dbPath), { recursive: true });
	const { DatabaseSync } = loadSqlite();
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("CREATE TABLE IF NOT EXISTS pi_goal_migrations (name TEXT PRIMARY KEY, applied_at_ms INTEGER NOT NULL)");

	const tableExistsStmt = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
	const migrationAppliedStmt = db.prepare("SELECT name FROM pi_goal_migrations WHERE name = ?");
	const markMigrationStmt = db.prepare("INSERT OR IGNORE INTO pi_goal_migrations(name, applied_at_ms) VALUES (?, ?)");
	function tableExists(name) {
		return Boolean(tableExistsStmt.get(name));
	}
	function columnExists(table, column) {
		return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
	}
	function addColumnIfMissing(table, column, definition) {
		if (!tableExists(table) || columnExists(table, column)) return;
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
	for (const name of MIGRATIONS) {
		if (migrationAppliedStmt.get(name)) continue;
		// Upgrade path from early pi-goal prototypes that created tables before migrations existed.
		if (name === "0029_thread_goals.sql" && tableExists("thread_goals")) {
			markMigrationStmt.run(name, nowMs());
			continue;
		}
		db.exec(migrationSql(name));
		markMigrationStmt.run(name, nowMs());
	}

	// Reconcile prototype databases that already had pi_goal_runtime before the
	// accounting-baseline columns were added. CREATE TABLE IF NOT EXISTS does not
	// evolve existing tables, so always patch missing pi-specific columns before
	// preparing statements that reference them.
	addColumnIfMissing("pi_goal_runtime", "continuation_requested_entry_count", "INTEGER");
	addColumnIfMissing("pi_goal_runtime", "accounting_active_goal_id", "TEXT");
	addColumnIfMissing("pi_goal_runtime", "accounting_turn_index", "INTEGER");
	addColumnIfMissing("pi_goal_runtime", "active_turn_started_at_ms", "INTEGER");
	addColumnIfMissing("pi_goal_runtime", "wall_clock_last_accounted_at_ms", "INTEGER");

	const ensureThreadStmt = db.prepare("INSERT OR IGNORE INTO threads(id) VALUES (?)");
	ensureThreadStmt.run(threadId);

	const getGoalStmt = db.prepare("SELECT * FROM thread_goals WHERE thread_id = ?");
	const getMetaStmt = db.prepare("SELECT * FROM pi_goal_metadata WHERE thread_id = ?");
	const getRuntimeStmt = db.prepare("SELECT * FROM pi_goal_runtime WHERE thread_id = ?");
	const replaceGoalStmt = db.prepare(`
INSERT INTO thread_goals (
    thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    goal_id = excluded.goal_id,
    objective = excluded.objective,
    status = CASE
        WHEN excluded.status = 'active' AND excluded.token_budget IS NOT NULL AND 0 >= excluded.token_budget THEN 'budget_limited'
        ELSE excluded.status
    END,
    token_budget = excluded.token_budget,
    tokens_used = 0,
    time_used_seconds = 0,
    created_at_ms = excluded.created_at_ms,
    updated_at_ms = excluded.updated_at_ms
`);
	const insertGoalStmt = db.prepare(`
INSERT INTO thread_goals (
    thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, 'active', ?, 0, 0, ?, ?)
ON CONFLICT(thread_id) DO NOTHING
`);
	const upsertGoalStmt = db.prepare(`
INSERT INTO thread_goals (
    thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    goal_id = excluded.goal_id,
    objective = excluded.objective,
    status = excluded.status,
    token_budget = excluded.token_budget,
    tokens_used = excluded.tokens_used,
    time_used_seconds = excluded.time_used_seconds,
    created_at_ms = excluded.created_at_ms,
    updated_at_ms = excluded.updated_at_ms
`);
	const upsertMetaStmt = db.prepare(`
INSERT INTO pi_goal_metadata (
    thread_id, goal_id, max_autonomous_turns, turns_used, autonomous_turns, stop_reason, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    goal_id = excluded.goal_id,
    max_autonomous_turns = excluded.max_autonomous_turns,
    turns_used = excluded.turns_used,
    autonomous_turns = excluded.autonomous_turns,
    stop_reason = excluded.stop_reason,
    updated_at_ms = excluded.updated_at_ms
`);
	const updateMetaPatchStmt = db.prepare(`
UPDATE pi_goal_metadata
SET
    max_autonomous_turns = COALESCE(?, max_autonomous_turns),
    turns_used = COALESCE(?, turns_used),
    autonomous_turns = COALESCE(?, autonomous_turns),
    stop_reason = ?,
    updated_at_ms = ?
WHERE thread_id = ? AND (? IS NULL OR goal_id = ?)
`);
	const deleteGoalStmt = db.prepare("DELETE FROM thread_goals WHERE thread_id = ?");
	const updateStatusStmt = db.prepare(`
UPDATE thread_goals
SET
    status = CASE
        WHEN status = 'budget_limited' AND ? = 'paused' THEN status
        WHEN ? = 'active' AND token_budget IS NOT NULL AND tokens_used >= token_budget THEN 'budget_limited'
        ELSE ?
    END,
    updated_at_ms = ?
WHERE thread_id = ? AND (? IS NULL OR goal_id = ?)
`);
	const updateBudgetStmt = db.prepare(`
UPDATE thread_goals
SET
    token_budget = ?,
    status = CASE
        WHEN status = 'active' AND ? IS NOT NULL AND tokens_used >= ? THEN 'budget_limited'
        ELSE status
    END,
    updated_at_ms = ?
WHERE thread_id = ? AND (? IS NULL OR goal_id = ?)
`);
	const accountUsageStmt = db.prepare(`
UPDATE thread_goals
SET
    time_used_seconds = time_used_seconds + ?,
    tokens_used = tokens_used + ?,
    status = CASE
        WHEN status = 'active' AND token_budget IS NOT NULL AND tokens_used + ? >= token_budget THEN 'budget_limited'
        ELSE status
    END,
    updated_at_ms = ?
WHERE thread_id = ?
  AND status IN ('active', 'budget_limited')
  AND (? IS NULL OR goal_id = ?)
`);
	const upsertRuntimeStmt = db.prepare(`
INSERT INTO pi_goal_runtime (
    thread_id,
    continuation_state,
    continuation_id,
    continuation_goal_id,
    continuation_updated_at_ms,
    continuation_start_entry_count,
    continuation_requested_entry_count,
    auto_continuation_suppressed,
    budget_limit_reported_goal_id,
    last_accounted_turn_message_tokens,
    current_turn_index,
    accounting_active_goal_id,
    accounting_turn_index,
    active_turn_started_at_ms,
    wall_clock_last_accounted_at_ms,
    updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    continuation_state = excluded.continuation_state,
    continuation_id = excluded.continuation_id,
    continuation_goal_id = excluded.continuation_goal_id,
    continuation_updated_at_ms = excluded.continuation_updated_at_ms,
    continuation_start_entry_count = excluded.continuation_start_entry_count,
    continuation_requested_entry_count = excluded.continuation_requested_entry_count,
    auto_continuation_suppressed = excluded.auto_continuation_suppressed,
    budget_limit_reported_goal_id = excluded.budget_limit_reported_goal_id,
    last_accounted_turn_message_tokens = excluded.last_accounted_turn_message_tokens,
    current_turn_index = excluded.current_turn_index,
    accounting_active_goal_id = excluded.accounting_active_goal_id,
    accounting_turn_index = excluded.accounting_turn_index,
    active_turn_started_at_ms = excluded.active_turn_started_at_ms,
    wall_clock_last_accounted_at_ms = excluded.wall_clock_last_accounted_at_ms,
    updated_at_ms = excluded.updated_at_ms
`);
	const insertEventStmt = db.prepare(`
INSERT INTO pi_goal_events(thread_id, event, at_ms, goal_json, runtime_json, note)
VALUES (?, ?, ?, ?, ?, ?)
`);
	const listEventsStmt = db.prepare(`
SELECT event, at_ms, goal_json, runtime_json, note
FROM pi_goal_events
WHERE thread_id = ?
ORDER BY at_ms ASC, rowid ASC
LIMIT ?
`);
	const listRecentEventsStmt = db.prepare(`
SELECT event, at_ms, goal_json, runtime_json, note
FROM pi_goal_events
WHERE thread_id = ?
ORDER BY at_ms DESC, rowid DESC
LIMIT ?
`);

	function getGoal() {
		return goalFromRows(getGoalStmt.get(threadId), getMetaStmt.get(threadId));
	}

	function getRuntime() {
		return runtimeFromRow(getRuntimeStmt.get(threadId));
	}

	function getSnapshot() {
		return { goal: getGoal(), runtime: getRuntime() };
	}

	function syncMetadata(goal, overrides = {}) {
		if (!goal) return;
		upsertMetaStmt.run(
			threadId,
			goal.goalId,
			intOrNull(overrides.maxAutonomousTurns ?? goal.maxAutonomousTurns),
			Math.max(0, Math.round(overrides.turnsUsed ?? goal.turnsUsed ?? 0)),
			Math.max(0, Math.round(overrides.autonomousTurns ?? goal.autonomousTurns ?? 0)),
			overrides.stopReason !== undefined ? overrides.stopReason : (goal.stopReason ?? null),
			Math.trunc(overrides.updatedAt ?? goal.updatedAt ?? nowMs()),
		);
	}

	function patchMetadata({ expectedGoalId = null, maxAutonomousTurns, turnsUsed, autonomousTurns, stopReason = null, updatedAt = nowMs() } = {}) {
		updateMetaPatchStmt.run(
			intOrNull(maxAutonomousTurns),
			turnsUsed === undefined ? null : Math.max(0, Math.round(turnsUsed)),
			autonomousTurns === undefined ? null : Math.max(0, Math.round(autonomousTurns)),
			stopReason,
			Math.trunc(updatedAt),
			threadId,
			expectedGoalId,
			expectedGoalId,
		);
	}

	function writeGoal(goal) {
		ensureThreadStmt.run(threadId);
		if (!goal) {
			deleteGoalStmt.run(threadId);
			return;
		}
		upsertGoalStmt.run(
			threadId,
			goal.goalId,
			goal.objective,
			goal.status,
			intOrNull(goal.tokenBudget),
			Math.max(0, Math.round(goal.tokensUsed ?? 0)),
			Math.max(0, Math.floor((goal.timeUsedMs ?? 0) / 1000)),
			Math.trunc(goal.createdAt),
			Math.trunc(goal.updatedAt),
		);
		syncMetadata(goal);
	}

	function writeRuntime(runtime) {
		const value = runtimeWithDefaults(runtime);
		upsertRuntimeStmt.run(
			threadId,
			value.continuationState,
			value.continuationId,
			value.continuationGoalId,
			intOrNull(value.continuationUpdatedAt),
			intOrNull(value.continuationStartEntryCount),
			intOrNull(value.continuationRequestedEntryCount),
			boolToInt(value.autoContinuationSuppressed),
			value.budgetLimitReportedGoalId,
			Math.max(0, Math.round(value.lastAccountedTurnMessageTokens ?? 0)),
			intOrNull(value.currentTurnIndex),
			value.accountingActiveGoalId,
			intOrNull(value.accountingTurnIndex),
			intOrNull(value.activeTurnStartedAt),
			intOrNull(value.wallClockLastAccountedAt),
			nowMs(),
		);
	}

	function recordEvent(event, goal, runtime, note, at = nowMs()) {
		insertEventStmt.run(threadId, event, Math.trunc(at), serialize(goal), serialize(runtimeWithDefaults(runtime)), note ?? null);
	}

	function transaction(callback) {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	function saveCheckpoint(goal, runtime, event, note, { record = true } = {}) {
		transaction(() => {
			writeGoal(goal);
			writeRuntime(runtime);
			if (record && event) recordEvent(event, goal, runtime, note);
		});
	}

	function replaceGoal({ objective, status = "active", tokenBudget = null, maxAutonomousTurns = null, goalId = randomUUID(), at = nowMs() }) {
		return transaction(() => {
			ensureThreadStmt.run(threadId);
			replaceGoalStmt.run(threadId, goalId, objective.trim(), status, intOrNull(tokenBudget), at, at);
			const goal = getGoal();
			syncMetadata({ ...goal, maxAutonomousTurns, turnsUsed: 0, autonomousTurns: 0, stopReason: undefined, updatedAt: at });
			return getGoal();
		});
	}

	function createGoal({ objective, tokenBudget = null, maxAutonomousTurns = null, goalId = randomUUID(), at = nowMs() }) {
		return transaction(() => {
			ensureThreadStmt.run(threadId);
			const result = insertGoalStmt.run(threadId, goalId, objective.trim(), intOrNull(tokenBudget), at, at);
			if (result.changes === 0) {
				throw new Error("cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete");
			}
			const goal = getGoal();
			syncMetadata({ ...goal, maxAutonomousTurns, turnsUsed: 0, autonomousTurns: 0, updatedAt: at });
			return getGoal();
		});
	}

	function setGoal({ objective, status = "active", tokenBudgetProvided = false, tokenBudget = null, maxAutonomousTurns, at = nowMs() }) {
		return transaction(() => {
			ensureThreadStmt.run(threadId);
			const existing = getGoal();
			if (!objective) {
				if (!existing) throw new Error(`cannot update goal for thread ${threadId}: no goal exists`);
				updateStatusStmt.run(status, status, status, at, threadId, existing.goalId, existing.goalId);
				if (tokenBudgetProvided) updateBudgetStmt.run(intOrNull(tokenBudget), intOrNull(tokenBudget), intOrNull(tokenBudget), at, threadId, existing.goalId, existing.goalId);
				patchMetadata({ expectedGoalId: existing.goalId, maxAutonomousTurns, stopReason: status === "active" ? null : existing.stopReason ?? null, updatedAt: at });
				return getGoal();
			}

			const trimmedObjective = objective.trim();
			const sameNonTerminal = existing && existing.objective === trimmedObjective && existing.status !== "complete";
			if (sameNonTerminal) {
				updateStatusStmt.run(status, status, status, at, threadId, existing.goalId, existing.goalId);
				if (tokenBudgetProvided) updateBudgetStmt.run(intOrNull(tokenBudget), intOrNull(tokenBudget), intOrNull(tokenBudget), at, threadId, existing.goalId, existing.goalId);
				patchMetadata({ expectedGoalId: existing.goalId, maxAutonomousTurns, stopReason: status === "active" ? null : existing.stopReason ?? null, updatedAt: at });
				return getGoal();
			}

			replaceGoalStmt.run(threadId, randomUUID(), trimmedObjective, status, intOrNull(tokenBudgetProvided ? tokenBudget : null), at, at);
			const goal = getGoal();
			syncMetadata({ ...goal, maxAutonomousTurns: maxAutonomousTurns ?? null, turnsUsed: 0, autonomousTurns: 0, stopReason: null, updatedAt: at });
			return getGoal();
		});
	}

	function setStatus({ status, expectedGoalId = null, stopReason = null, at = nowMs() }) {
		return transaction(() => {
			const current = getGoal();
			if (!current || (expectedGoalId && current.goalId !== expectedGoalId)) {
				throw new Error(`cannot update goal for thread ${threadId}: no goal exists`);
			}
			if (current.status === "complete" && status !== "complete") {
				throw new Error("cannot resume a completed goal; clear it or create a new goal");
			}
			const result = updateStatusStmt.run(status, status, status, at, threadId, expectedGoalId, expectedGoalId);
			if (result.changes === 0) throw new Error(`cannot update goal for thread ${threadId}: no goal exists`);
			patchMetadata({ expectedGoalId, stopReason, updatedAt: at });
			return getGoal();
		});
	}

	function setBudget({ tokenBudget, expectedGoalId = null, at = nowMs() }) {
		return transaction(() => {
			const value = intOrNull(tokenBudget);
			const result = updateBudgetStmt.run(value, value, value, at, threadId, expectedGoalId, expectedGoalId);
			if (result.changes === 0) throw new Error(`cannot update goal for thread ${threadId}: no goal exists`);
			return getGoal();
		});
	}

	function accountUsage({ timeDeltaMs = 0, tokenDelta = 0, expectedGoalId = null, turnIncrement = 0, at = nowMs() }) {
		return transaction(() => {
			const timeDeltaSeconds = Math.max(0, Math.floor(timeDeltaMs / 1000));
			const tokens = Math.max(0, Math.round(tokenDelta));
			if (timeDeltaSeconds > 0 || tokens > 0) {
				accountUsageStmt.run(timeDeltaSeconds, tokens, tokens, at, threadId, expectedGoalId, expectedGoalId);
			}
			const current = getGoal();
			if (current && turnIncrement > 0) {
				patchMetadata({
					expectedGoalId: current.goalId,
					turnsUsed: (current.turnsUsed ?? 0) + turnIncrement,
					stopReason: current.stopReason ?? null,
					updatedAt: at,
				});
			}
			return getGoal();
		});
	}

	function incrementAutonomousTurns({ expectedGoalId = null, at = nowMs() } = {}) {
		return transaction(() => {
			const current = getGoal();
			if (!current) return null;
			if (expectedGoalId && current.goalId !== expectedGoalId) throw new Error("goal changed before autonomous continuation could be queued");
			patchMetadata({
				expectedGoalId: current.goalId,
				autonomousTurns: (current.autonomousTurns ?? 0) + 1,
				stopReason: current.stopReason ?? null,
				updatedAt: at,
			});
			return getGoal();
		});
	}

	function clearGoal() {
		const hadGoal = Boolean(getGoal());
		deleteGoalStmt.run(threadId);
		return hadGoal;
	}

	function listEvents(limit = 100) {
		const rows = listEventsStmt.all(threadId, Math.max(1, Math.trunc(limit)));
		return rows.map(eventFromRow);
	}

	function listRecentEvents(limit = 100) {
		const rows = listRecentEventsStmt.all(threadId, Math.max(1, Math.trunc(limit)));
		return rows.reverse().map(eventFromRow);
	}

	function close() {
		db.close();
	}

	return {
		dbPath,
		threadId,
		getGoal,
		getRuntime,
		getSnapshot,
		saveCheckpoint,
		recordEvent,
		replaceGoal,
		createGoal,
		setGoal,
		setStatus,
		setBudget,
		accountUsage,
		incrementAutonomousTurns,
		clearGoal,
		listEvents,
		listRecentEvents,
		close,
	};
}
