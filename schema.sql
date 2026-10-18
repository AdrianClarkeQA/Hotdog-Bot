-- Per-channel monitoring config.
-- original_parent_id is the channel's "home" category: where it lived before
-- Botdog archived it, or the category chosen when restoring a channel that
-- was archived by hand. Kept after restore so the home is never forgotten.
CREATE TABLE IF NOT EXISTS channels (
  channel_id         TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 1,   -- 1 = monitored, 0 = ignored
  days               INTEGER NOT NULL DEFAULT 30,  -- inactivity threshold
  original_parent_id TEXT,                         -- home category to restore to
  is_archived        INTEGER NOT NULL DEFAULT 0,   -- 1 = currently in the archive category
  restored_at        INTEGER                       -- ms timestamp of last restore; restarts the inactivity clock
);

-- Saved game list for /gaming autocomplete. One row per game; name_key is the
-- lowercased, whitespace-tidied name so "Helldivers 2" and "helldivers 2" match.
CREATE TABLE IF NOT EXISTS games (
  name_key  TEXT PRIMARY KEY,
  name      TEXT NOT NULL,              -- spelling shown in Discord
  uses      INTEGER NOT NULL DEFAULT 1, -- sessions posted; most-used suggested first
  last_used INTEGER NOT NULL,           -- ms timestamp of latest session
  added_by  TEXT,                       -- Discord user id who first entered it
  added_at  INTEGER NOT NULL,
  coop_status TEXT                      -- NULL = not on the co-op list; else ready / not_purchased / parked / completed
);

-- Saved quotes (/quote, /quotes, "Save as quote"). A /quote row starts with
-- posted = 0 and no speaker while Botdog asks who said it.
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

-- Botdog's co-op list post(s) in COOP_CHANNEL_ID. Normally one row; the
-- older post is deleted as soon as a newer one is up.
CREATE TABLE IF NOT EXISTS coop_board_posts (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  posted_at  INTEGER NOT NULL
);

-- Single-row global switch. id is always 1.
CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  global_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO settings (id, global_enabled) VALUES (1, 1);
