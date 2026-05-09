-- pi-goal extension metadata kept separate from Codex-compatible thread_goals.
CREATE TABLE IF NOT EXISTS pi_goal_metadata (
    thread_id TEXT PRIMARY KEY,
    goal_id TEXT,
    max_autonomous_turns INTEGER,
    turns_used INTEGER NOT NULL DEFAULT 0,
    autonomous_turns INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES thread_goals(thread_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pi_goal_runtime (
    thread_id TEXT PRIMARY KEY,
    continuation_state TEXT NOT NULL DEFAULT 'idle',
    continuation_id TEXT,
    continuation_goal_id TEXT,
    continuation_updated_at_ms INTEGER,
    continuation_start_entry_count INTEGER,
    continuation_requested_entry_count INTEGER,
    auto_continuation_suppressed INTEGER NOT NULL DEFAULT 0,
    budget_limit_reported_goal_id TEXT,
    last_accounted_turn_message_tokens INTEGER NOT NULL DEFAULT 0,
    current_turn_index INTEGER,
    accounting_active_goal_id TEXT,
    accounting_turn_index INTEGER,
    active_turn_started_at_ms INTEGER,
    wall_clock_last_accounted_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pi_goal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    event TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    goal_json TEXT,
    runtime_json TEXT,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_pi_goal_events_thread_at ON pi_goal_events(thread_id, at_ms);
