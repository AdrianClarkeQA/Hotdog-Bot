-- v1.7.0: tracks Botdog's co-op list post in COOP_CHANNEL_ID so the old one
-- can be deleted when a new one is posted.
-- Run against the live database:  npm run db:migrate:coopboard
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS coop_board_posts (
  message_id TEXT PRIMARY KEY,   -- Discord message id of the post
  channel_id TEXT NOT NULL,      -- channel it was posted in
  posted_at  INTEGER NOT NULL    -- ms timestamp
);
