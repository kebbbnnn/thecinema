-- Migration: 0001_initial_schema.sql
-- Description: Create theater_snapshots and fetch_log tables

CREATE TABLE IF NOT EXISTS theater_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,         -- 'YYYY-MM-DD' in Philippine Time (UTC+8)
  province_slug TEXT NOT NULL,         -- e.g. 'cebu', 'quezon-city'
  theater_id INTEGER NOT NULL,         -- API ID e.g. 75
  theater_type TEXT,                   -- e.g. 'TM'
  slug TEXT,                           -- e.g. 'ayala-center-cebu'
  branch_id TEXT,                      -- e.g. '7401'
  name TEXT NOT NULL,                  -- e.g. 'Ayala Center Cebu'
  address1 TEXT,
  address2 TEXT,
  city TEXT,
  logo_url TEXT,
  longitude TEXT,
  latitude TEXT,
  buy_ticket INTEGER DEFAULT 0,        -- 0 for false, 1 for true
  mall_group_id TEXT,
  province TEXT,                       -- Location/Province name from API e.g. 'Cebu'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,         -- 'YYYY-MM-DD' in Philippine Time (UTC+8)
  run_type TEXT NOT NULL,              -- 'initial' (12:00 AM PHT) or 'refresh' (6:00 AM PHT)
  province_slug TEXT NOT NULL,
  location_name TEXT,                  -- Location name from API response
  theater_count INTEGER DEFAULT 0,
  status TEXT NOT NULL,                -- 'success' or 'error'
  error_message TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_province ON theater_snapshots(province_slug, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON theater_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_fetch_log_date ON fetch_log(snapshot_date);
