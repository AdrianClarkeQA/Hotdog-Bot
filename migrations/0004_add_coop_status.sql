-- v1.6.0: co-op status for saved games (/coop set, /coop recommend, /coop list).
-- Run ONCE against the live database:  npm run db:migrate:coop
-- (Running it twice errors with "duplicate column" — harmless, nothing changes.)
-- NULL = not on the co-op list. Otherwise one of:
--   ready, not_purchased, parked, completed
ALTER TABLE games ADD COLUMN coop_status TEXT;
