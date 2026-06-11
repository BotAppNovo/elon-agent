'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

let pool;

function getPool() {
  if (!pool) throw new Error('Database nao inicializado — chame initDb() primeiro');
  return pool;
}

async function initDb() {
  const isLocal = DATABASE_URL && (
    DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1')
  );

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  // Smoke-test the connection
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id            SERIAL PRIMARY KEY,
      content       TEXT        NOT NULL,
      format        TEXT        NOT NULL,
      tweet_ids     TEXT,
      source        TEXT        NOT NULL DEFAULT 'manual',
      linkedin_post_id TEXT,
      published_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contexts (
      id         SERIAL PRIMARY KEY,
      content    TEXT        NOT NULL,
      active     INTEGER     NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rss_sources (
      id         SERIAL PRIMARY KEY,
      name       TEXT        NOT NULL,
      url        TEXT        NOT NULL UNIQUE,
      active     INTEGER     NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS replied_tweets (
      tweet_id     TEXT        PRIMARY KEY,
      reply_text   TEXT,
      reply_id     TEXT,
      status       TEXT        NOT NULL DEFAULT 'suggested',
      suggested_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Default: autonomous_mode off
  const existing = await pool.query(
    "SELECT value FROM settings WHERE key = 'autonomous_mode'"
  );
  if (existing.rows.length === 0) {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('autonomous_mode', 'false')"
    );
  }

  // Default: copilot_enabled on
  const existingCopilot = await pool.query(
    "SELECT value FROM settings WHERE key = 'copilot_enabled'"
  );
  if (existingCopilot.rows.length === 0) {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('copilot_enabled', 'true')"
    );
  }

  return pool;
}

// ----- Settings -----

async function saveSetting(key, value) {
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function getSetting(key) {
  const res = await getPool().query(
    'SELECT value FROM settings WHERE key = $1',
    [key]
  );
  return res.rows[0] ? res.rows[0].value : null;
}

// ----- Posts -----

async function savePost({ content, format, tweet_ids = [], source = 'manual', linkedin_post_id = null }) {
  const res = await getPool().query(
    `INSERT INTO posts (content, format, tweet_ids, source, linkedin_post_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [content, format, JSON.stringify(tweet_ids), source, linkedin_post_id]
  );
  return res.rows[0].id;
}

async function getRecentPosts(limit = 20) {
  const res = await getPool().query(
    'SELECT * FROM posts ORDER BY published_at DESC LIMIT $1',
    [limit]
  );
  return res.rows;
}

// ----- Contexts -----

async function saveContext(content) {
  const res = await getPool().query(
    'INSERT INTO contexts (content) VALUES ($1) RETURNING id',
    [content]
  );
  return res.rows[0].id;
}

async function getActiveContexts(limit = 8) {
  const res = await getPool().query(
    'SELECT * FROM contexts WHERE active = 1 ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return res.rows;
}

async function listContexts() {
  const res = await getPool().query(
    'SELECT * FROM contexts WHERE active = 1 ORDER BY created_at DESC'
  );
  return res.rows;
}

async function deactivateContext(id) {
  await getPool().query(
    'UPDATE contexts SET active = 0 WHERE id = $1',
    [id]
  );
}

async function clearContexts() {
  await getPool().query('UPDATE contexts SET active = 0');
}

// ----- RSS Sources -----

async function getRssSources() {
  const res = await getPool().query(
    'SELECT * FROM rss_sources WHERE active = 1 ORDER BY created_at ASC'
  );
  return res.rows;
}

async function saveRssSource(name, url) {
  const res = await getPool().query(
    `INSERT INTO rss_sources (name, url) VALUES ($1, $2)
     ON CONFLICT (url) DO NOTHING
     RETURNING id`,
    [name, url]
  );
  return res.rows[0]?.id ?? null;
}

async function removeRssSource(id) {
  await getPool().query(
    'UPDATE rss_sources SET active = 0 WHERE id = $1',
    [id]
  );
}

// ----- Replied Tweets (copilot) -----

async function isTweetSuggested(tweetId) {
  const res = await getPool().query(
    'SELECT 1 FROM replied_tweets WHERE tweet_id = $1',
    [tweetId]
  );
  return res.rows.length > 0;
}

async function saveSuggestedTweet(tweetId, replyText) {
  await getPool().query(
    `INSERT INTO replied_tweets (tweet_id, reply_text, status)
     VALUES ($1, $2, 'suggested')
     ON CONFLICT (tweet_id) DO NOTHING`,
    [tweetId, replyText]
  );
}

async function markTweetReplied(tweetId, replyId) {
  await getPool().query(
    `UPDATE replied_tweets SET reply_id = $1, status = 'replied' WHERE tweet_id = $2`,
    [replyId, tweetId]
  );
}

async function markTweetSkipped(tweetId) {
  await getPool().query(
    `UPDATE replied_tweets SET status = 'skipped' WHERE tweet_id = $1`,
    [tweetId]
  );
}

module.exports = {
  initDb,
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
  isTweetSuggested,
  saveSuggestedTweet,
  markTweetReplied,
  markTweetSkipped,
};
