-- v1.2.0: adds restored_at so a restored channel gets a fresh inactivity window.
-- Run ONCE against the live database:  npm run db:migrate
-- (Running it twice errors with "duplicate column" — harmless, nothing changes.)
ALTER TABLE channels ADD COLUMN restored_at INTEGER;
