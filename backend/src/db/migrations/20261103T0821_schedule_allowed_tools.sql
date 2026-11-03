-- Outils pré-autorisés propres à une planification : règles au format Claude Code (Bash(git status *),
-- mcp__vault__sql_query(production)…) appliquées aux seuls tours lancés par la planification.
ALTER TABLE session_schedules ADD COLUMN IF NOT EXISTS allowed_tools text[] NOT NULL DEFAULT '{}';
