import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const columns = 'id, type, imdbId, videoId, title, season, episode, lang, label, originalName, extension, bytes, createdAt';

export class Library {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'library.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subtitles (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, imdbId TEXT NOT NULL, videoId TEXT NOT NULL,
        title TEXT NOT NULL, season INTEGER, episode INTEGER, lang TEXT NOT NULL, label TEXT NOT NULL,
        originalName TEXT NOT NULL, extension TEXT NOT NULL, bytes INTEGER NOT NULL,
        hash TEXT NOT NULL, content BLOB NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(type, videoId, lang, label, hash)
      );
      CREATE INDEX IF NOT EXISTS subtitles_video ON subtitles(type, videoId);
    `);
    if (!this.getSetting('addonKey')) this.setSetting('addonKey', randomBytes(24).toString('hex'));
  }
  getSetting(key) { return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? ''; }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value); }
  list() { return this.db.prepare(`SELECT ${columns} FROM subtitles ORDER BY createdAt DESC, id`).all(); }
  matches(type, videoId) { return this.db.prepare(`SELECT ${columns} FROM subtitles WHERE type = ? AND videoId = ? ORDER BY createdAt DESC, id`).all(type, videoId); }
  add(meta, file) {
    const existing = this.db.prepare(`SELECT ${columns} FROM subtitles WHERE type = ? AND videoId = ? AND lang = ? AND label = ? AND hash = ?`).get(meta.type, meta.videoId, meta.lang, meta.label, file.hash);
    if (existing) return { subtitle: existing, duplicate: true };
    const row = { ...meta, ...file, id: randomUUID(), createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO subtitles (id, type, imdbId, videoId, title, season, episode, lang, label, originalName, extension, bytes, hash, content, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.type, row.imdbId, row.videoId, row.title, row.season, row.episode, row.lang, row.label, row.originalName, row.extension, row.bytes, row.hash, row.content, row.createdAt);
    return { subtitle: this.db.prepare(`SELECT ${columns} FROM subtitles WHERE id = ?`).get(row.id), duplicate: false };
  }
  file(id) { return this.db.prepare('SELECT content, extension, originalName FROM subtitles WHERE id = ?').get(id); }
  delete(id) { return this.db.prepare('DELETE FROM subtitles WHERE id = ?').run(id).changes > 0; }
  close() { this.db.close(); }
}
