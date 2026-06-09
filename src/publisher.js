'use strict';

const { TwitterApi } = require('twitter-api-v2');

let _client;

function getClient() {
  if (!_client) {
    _client = new TwitterApi({
      appKey:      process.env.X_CLIENT_ID,
      appSecret:   process.env.X_CLIENT_SECRET,
      accessToken: process.env.X_ACCESS_TOKEN,
      accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
    });
  }
  return _client;
}

// ─────────────────────────────────────────────
// Primitivos de publicação
// ─────────────────────────────────────────────

async function publishTweet(text) {
  const client = getClient();
  const result = await client.v2.tweet({ text });
  return { id: result.data.id, raw: result };
}

async function publishThread(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) {
    throw new Error('Thread precisa de pelo menos 1 tweet');
  }

  const client = getClient();
  const ids = [];
  let previousId = null;

  const raws = [];
  for (const text of tweets) {
    const payload = { text };
    if (previousId) {
      payload.reply = { in_reply_to_tweet_id: previousId };
    }
    const result = await client.v2.tweet(payload);
    ids.push(result.data.id);
    raws.push(result);
    previousId = result.data.id;

    // Pequena pausa entre tweets para evitar rate limit
    if (tweets.indexOf(text) < tweets.length - 1) {
      await sleep(800);
    }
  }

  return { ids, raw: raws };
}

async function publishPoll(text, options, durationMinutes = 1440) {
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error('Enquete precisa de pelo menos 2 opcoes');
  }

  const client = getClient();

  // API do X aceita no máximo 4 opções, máx 25 chars cada
  const cleanOptions = options
    .slice(0, 4)
    .map((o) => ({ label: String(o).substring(0, 25) }));

  const result = await client.v2.tweet({
    text,
    poll: {
      options: cleanOptions,
      duration_minutes: durationMinutes,
    },
  });

  return { id: result.data.id, raw: result };
}

// ─────────────────────────────────────────────
// Dispatcher principal — recebe objeto post
// ─────────────────────────────────────────────

async function publish(post) {
  switch (post.format) {
    case 'thread':
      if (!Array.isArray(post.tweets) || post.tweets.length === 0) {
        throw new Error('Post tipo thread sem tweets definidos');
      }
      return publishThread(post.tweets);

    case 'poll':
      if (!Array.isArray(post.poll_options) || post.poll_options.length < 2) {
        throw new Error('Post tipo poll sem opcoes validas');
      }
      return publishPoll(post.content, post.poll_options);

    default:
      // opinion, question, metric — post simples
      if (!post.content) throw new Error('Post sem conteudo');
      return publishTweet(post.content);
  }
}

/**
 * Normaliza o retorno de publish() para sempre retornar um array de IDs.
 * result pode ser: { id, raw } (tweet/poll) ou { ids, raw } (thread)
 */
function normalizeIds(result) {
  if (result?.ids) return result.ids;   // thread
  if (result?.id)  return [result.id];  // tweet/poll
  // fallback para strings/arrays legados
  if (Array.isArray(result)) return result;
  return [result];
}

/**
 * Retorna o(s) objeto(s) raw da resposta da API do X.
 */
function rawResponse(result) {
  if (result?.raw) return result.raw;
  return result;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Monta a URL do primeiro tweet publicado (para link direto).
 */
function tweetUrl(tweetId, username) {
  if (username) return `https://x.com/${username}/status/${tweetId}`;
  return `https://x.com/i/web/status/${tweetId}`;
}

module.exports = { publish, publishTweet, publishThread, publishPoll, normalizeIds, rawResponse, tweetUrl };
