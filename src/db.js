'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/elon.db');

let db;

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content     TEXT    NOT NULL,
      format      TEXT    NOT NULL,
      tweet_ids   TEXT,
      source      TEXT    NOT NULL DEFAULT 'manual',
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contexts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT    NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rss_sources (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      url        TEXT    NOT NULL UNIQUE,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migração: adiciona linkedin_post_id se a coluna ainda não existir
  try {
    db.exec('ALTER TABLE posts ADD COLUMN linkedin_post_id TEXT');
  } catch {
    // Coluna já existe — ignorar
  }

  // Defaults
  if (getSetting('autonomous_mode') === null) {
    saveSetting('autonomous_mode', 'false');
  }

  return db;
}

function getDb() {
  if (!db) throw new Error('Database nao inicializado — chame initDb() primeiro');
  return db;
}

// ----- Settings -----

function saveSetting(key, value) {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

function getSetting(key) {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key);
  return row ? row.value : null;
}

// ----- Posts -----

function savePost({ content, format, tweet_ids = [], source = 'manual', linkedin_post_id = null }) {
  const result = getDb()
    .prepare('INSERT INTO posts (content, format, tweet_ids, source, linkedin_post_id) VALUES (?, ?, ?, ?, ?)')
    .run(content, format, JSON.stringify(tweet_ids), source, linkedin_post_id);
  return result.lastInsertRowid;
}

function getRecentPosts(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM posts ORDER BY published_at DESC LIMIT ?')
    .all(limit);
}

// ----- Contexts -----

function saveContext(content) {
  const result = getDb()
    .prepare('INSERT INTO contexts (content) VALUES (?)')
    .run(content);
  return result.lastInsertRowid;
}

function getActiveContexts(limit = 8) {
  return getDb()
    .prepare('SELECT * FROM contexts WHERE active = 1 ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

function listContexts() {
  return getDb()
    .prepare('SELECT * FROM contexts WHERE active = 1 ORDER BY created_at DESC')
    .all();
}

function deactivateContext(id) {
  getDb()
    .prepare('UPDATE contexts SET active = 0 WHERE id = ?')
    .run(id);
}

function clearContexts() {
  getDb()
    .prepare('UPDATE contexts SET active = 0')
    .run();
}

// ----- RSS Sources -----

function getRssSources() {
  return getDb()
    .prepare('SELECT * FROM rss_sources WHERE active = 1 ORDER BY created_at ASC')
    .all();
}

function saveRssSource(name, url) {
  const result = getDb()
    .prepare('INSERT OR IGNORE INTO rss_sources (name, url) VALUES (?, ?)')
    .run(name, url);
  return result.lastInsertRowid;
}

function removeRssSource(id) {
  getDb()
    .prepare('UPDATE rss_sources SET active = 0 WHERE id = ?')
    .run(id);
}

module.exports = {
  initDb,
  getDb,
  saveSetting,
  getSetting,
  savePost,
  getRecentPosts,
  saveContext,
  getActiveContexts,
  listContexts,
  deactivateContext,
  clearContexts,
  getRssSources,
  saveRssSource,
  removeRssSource,
};
