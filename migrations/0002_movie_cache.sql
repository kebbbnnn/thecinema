-- ============================================================================
-- Migration: 0002_movie_cache.sql
-- Persistent document cache for movie full details
-- ============================================================================

CREATE TABLE IF NOT EXISTS movie_cache (
  hash TEXT PRIMARY KEY,
  movie_id INTEGER,
  slug TEXT,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  cached_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movie_cache_movie_id ON movie_cache (movie_id);
CREATE INDEX IF NOT EXISTS idx_movie_cache_slug ON movie_cache (slug);
