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

-- Single-row global switch. id is always 1.
CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  global_enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO settings (id, global_enabled) VALUES (1, 1);
