-- v1.5.0: saved quotes for /quote, /quotes and "Save as quote".
-- Run against the live database:  npm run db:migrate:quotes
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS quotes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT NOT NULL,
  speaker_id   TEXT,                       -- Discord user id when said by a server member
  speaker_name TEXT,                       -- name shown in /quotes suggestions
  speaker_key  TEXT,                       -- "u:<user id>" or "n:<lowercased name>": groups a person's quotes
  added_by     TEXT,                       -- Discord user id of whoever saved it
  created_at   INTEGER NOT NULL,           -- ms timestamp
  posted       INTEGER NOT NULL DEFAULT 0, -- 0 = waiting for "who said it?", 1 = posted
  source_url   TEXT                        -- link to the original message ("Save as quote" only)
);
CREATE INDEX IF NOT EXISTS quotes_by_speaker ON quotes (speaker_key, posted, created_at);
