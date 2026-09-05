-- Per-channel monitoring config.
-- original_parent_id records where a channel lived BEFORE archiving,
-- so it can be restored to the right category.
CREATE TABLE IF NOT EXISTS channels (
  channel_id         TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 1,   -- 1 = monitored, 0 = ignored
  days               INTEGER NOT NULL DEFAULT 30,  -- inactivity threshold
  original_parent_id TEXT,                         -- category to restore to; NULL if not archived
  is_archived        INTEGER NOT NULL DEFAULT 0    -- 1 = currently in the archive category
);

-- Single-row global switch. id is always 1.
CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  global_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO settings (id, global_enabled) VALUES (1, 1);
