-- v1.11.0: /gaming creates Discord events. Botdog posts each event's link in
-- GAMING_CHANNEL_ID and records it here, so the nightly clean-up can delete
-- the post once the session's day has passed.
-- Run against the live database:  npm run db:migrate:events
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS session_posts (
  message_id     TEXT PRIMARY KEY,   -- Discord message id of the link post
  channel_id     TEXT NOT NULL,      -- channel it was posted in
  event_id       TEXT NOT NULL,      -- Discord scheduled event id
  starts_at      INTEGER NOT NULL,   -- ms timestamp the session starts
  title_template TEXT,               -- title picked, so the next session gets a different one
  created_by     TEXT,               -- Discord user id of whoever ran /gaming
  created_at     INTEGER NOT NULL,   -- ms timestamp
  removed_at     INTEGER             -- ms timestamp the post was deleted; NULL = still up
);
CREATE INDEX IF NOT EXISTS session_posts_to_remove ON session_posts (removed_at, starts_at);
