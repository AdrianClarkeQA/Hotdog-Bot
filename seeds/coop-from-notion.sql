-- One-time import of co-op games and statuses from the Notion database
-- "Co-op Gaming Suggestions" (19 games, read 18/10/2026).
-- Run against the live database:
--   npx wrangler d1 execute hotdog-db --remote --file=./seeds/coop-from-notion.sql
-- Safe to run more than once. Games already saved (e.g. from /gaming) keep
-- their spelling and session count; only their co-op status is set.
-- Needs the coop_status column from v1.6.0.
INSERT INTO games (name_key, name, uses, last_used, added_by, added_at, coop_status) VALUES
  ('age of empires 2', 'Age of Empires 2', 0, 0, NULL, 1792281600000, 'ready'),
  ('astroneer', 'Astroneer', 0, 0, NULL, 1792281600000, 'ready'),
  ('borderlands 4', 'Borderlands 4', 0, 0, NULL, 1792281600000, 'not_purchased'),
  ('civilization vi', 'Civilization VI', 0, 0, NULL, 1792281600000, 'ready'),
  ('forza horizon 6', 'Forza Horizon 6', 0, 0, NULL, 1792281600000, 'parked'),
  ('ghost recon wildlands', 'Ghost Recon Wildlands', 0, 0, NULL, 1792281600000, 'completed'),
  ('marvel cosmic invasion', 'Marvel Cosmic Invasion', 0, 0, NULL, 1792281600000, 'ready'),
  ('minecraft', 'Minecraft', 0, 0, NULL, 1792281600000, 'ready'),
  ('minecraft dungeons 2', 'Minecraft Dungeons 2', 0, 0, NULL, 1792281600000, 'not_purchased'),
  ('no mans sky', 'No Mans Sky', 0, 0, NULL, 1792281600000, 'parked'),
  ('parkitect', 'Parkitect', 0, 0, NULL, 1792281600000, 'ready'),
  ('ready or not', 'Ready or Not', 0, 0, NULL, 1792281600000, 'parked'),
  ('roadcraft', 'Roadcraft', 0, 0, NULL, 1792281600000, 'ready'),
  ('sniper elite 5', 'Sniper Elite 5', 0, 0, NULL, 1792281600000, 'ready'),
  ('snowrunner', 'SnowRunner', 0, 0, NULL, 1792281600000, 'not_purchased'),
  ('stardew valley', 'Stardew Valley', 0, 0, NULL, 1792281600000, 'ready'),
  ('state of decay 3', 'State of Decay 3', 0, 0, NULL, 1792281600000, 'not_purchased'),
  ('travellers rest', 'Travellers Rest', 0, 0, NULL, 1792281600000, 'ready'),
  ('world of warships', 'World of Warships', 0, 0, NULL, 1792281600000, 'ready')
ON CONFLICT(name_key) DO UPDATE SET coop_status = excluded.coop_status;
