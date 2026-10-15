CREATE TABLE IF NOT EXISTS subtitles (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, imdbId TEXT NOT NULL, videoId TEXT NOT NULL,
  title TEXT NOT NULL, season INTEGER, episode INTEGER, lang TEXT NOT NULL, label TEXT NOT NULL,
  originalName TEXT NOT NULL, extension TEXT NOT NULL, bytes INTEGER NOT NULL,
  hash TEXT NOT NULL, createdAt TEXT NOT NULL,
  UNIQUE(type, videoId, lang, label, hash)
);
CREATE INDEX IF NOT EXISTS subtitles_video ON subtitles(type, videoId);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, credentialTag TEXT NOT NULL, expiresAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expiresAt);
CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_expiry ON login_attempts(expiresAt);
