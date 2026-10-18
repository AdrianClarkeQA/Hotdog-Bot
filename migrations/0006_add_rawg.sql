-- v1.10.0: game details from RAWG (ratings, images, co-op modes) for saved games.
-- Run ONCE against the live database:  npm run db:migrate:rawg
-- (Running it twice errors with "duplicate column" — harmless, nothing changes.)
-- All columns start empty; Botdog fills them as games are looked up.
ALTER TABLE games ADD COLUMN rawg_id INTEGER;            -- RAWG game id; NULL = no match yet
ALTER TABLE games ADD COLUMN rawg_slug TEXT;             -- for the rawg.io/games/<slug> link
ALTER TABLE games ADD COLUMN rawg_name TEXT;             -- the game's name on RAWG
ALTER TABLE games ADD COLUMN image_url TEXT;             -- RAWG background image
ALTER TABLE games ADD COLUMN metacritic INTEGER;         -- Metacritic score, 0-100
ALTER TABLE games ADD COLUMN rawg_rating REAL;           -- RAWG user rating, out of 5
ALTER TABLE games ADD COLUMN rawg_ratings_count INTEGER;
ALTER TABLE games ADD COLUMN released TEXT;              -- YYYY-MM-DD, or TBA
ALTER TABLE games ADD COLUMN playtime INTEGER;           -- average hours played
ALTER TABLE games ADD COLUMN genres TEXT;                -- comma-separated
ALTER TABLE games ADD COLUMN platforms TEXT;             -- comma-separated
ALTER TABLE games ADD COLUMN coop_modes TEXT;            -- e.g. "Online co-op, Split-screen"
ALTER TABLE games ADD COLUMN rawg_checked_at INTEGER;    -- ms timestamp of the last lookup; NULL = never looked up
