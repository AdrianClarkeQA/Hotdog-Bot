-- v1.3.0: saved game list for /gaming autocomplete.
-- Run against the live database:  npm run db:migrate:games
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS games (
  name_key  TEXT PRIMARY KEY,           -- lowercased, spacing tidied: one row per game
  name      TEXT NOT NULL,              -- spelling shown in Discord (as first entered)
  uses      INTEGER NOT NULL DEFAULT 1, -- sessions posted; most-used games are suggested first
  last_used INTEGER NOT NULL,           -- ms timestamp of the latest session
  added_by  TEXT,                       -- Discord user id of whoever first entered it
  added_at  INTEGER NOT NULL            -- ms timestamp
);
