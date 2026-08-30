-- ============================================================================
-- Migration: 0003_theater_custom_images.sql
-- Persistent storage for custom theater images uploaded via admin dashboard
-- ============================================================================

CREATE TABLE IF NOT EXISTS theater_custom_images (
  slug TEXT PRIMARY KEY,
  theater_id INTEGER,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  file_id TEXT,
  thumbnail_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_theater_custom_images_slug ON theater_custom_images (slug);
