'use strict';

const { TwitterApi } = require('twitter-api-v2');

const client = new TwitterApi({
  clientId:     process.env.X_CLIENT_ID,
  clientSecret: process.env.X_CLIENT_SECRET,
});

const userClient = new TwitterApi(process.env.X_ACCESS_TOKEN);

console.log('[publisher] Inicializando cliente X (OAuth 2.0) com:', {
  clientId:    process.env.X_CLIENT_ID    ? process.env.X_CLIENT_ID.substring(0, 8)    + '...' : 'AUSENTE',
  accessToken: process.env.X_ACCESS_TOKEN ? process.env.X_ACCESS_TOKEN.substring(0, 8) + '...' : 'AUSENTE',
});

// ─────────────────────────────────────────────
// Primitivos de publicação
// ─────────────────────────────────────────────

async function publishTweet(text) {
  const result = await userClient.v2.tweet({ text });
  return { id: result.data.id, raw: result };
}

async function publishThread(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) {
    throw new Error('Thread precisa de pelo menos 1 tweet');
  }

  const ids = [];
  let previousId = null;

  const raws = [];
  for (let i = 0; i < tweets.length; i++) {
    const text = tweets[i];
    const payload = { text };
    if (previousId) {
      payload.reply = { in_reply_to_tweet_id: previousId };
    }
    const result = await userClient.v2.tweet(payload);
    ids.push(result.data.id);
    raws.push(result);
    previousId = result.data.id;

    // Pequena pausa entre tweets para evitar rate limit
    if (i < tweets.length - 1) {
      await sleep(800);
    }
  }

  return { ids, raw: raws };
}

async function publishPoll(text, options, durationMinutes = 1440) {
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error('Enquete precisa de pelo menos 2 opcoes');
  }

  // API do X aceita no máximo 4 opções, máx 25 chars cada
  const cleanOptions = options
    .slice(0, 4)
    .map((o) => ({ label: String(o).substring(0, 25) }));

  const result = await userClient.v2.tweet({
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
