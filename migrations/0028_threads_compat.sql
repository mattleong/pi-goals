-- pi-goal compatibility table so Codex's 0029_thread_goals.sql can run
-- outside Codex's state DB, where the canonical threads table already exists.
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL
);
