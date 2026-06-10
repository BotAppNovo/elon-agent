'use strict';

const { TwitterApi } = require('twitter-api-v2');

const client = new TwitterApi({
  appKey:       process.env.X_CLIENT_ID,
  appSecret:    process.env.X_CLIENT_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

const rwClient = client.readWrite;

console.log('[publisher] Inicializando cliente X com:', {
  appKey:       process.env.X_CLIENT_ID              ? process.env.X_CLIENT_ID.substring(0, 8)              + '...' : 'AUSENTE',
  appSecret:    process.env.X_CLIENT_SECRET          ? process.env.X_CLIENT_SECRET.substring(0, 8)          + '...' : 'AUSENTE',
  accessToken:  process.env.X_ACCESS_TOKEN           ? process.env.X_ACCESS_TOKEN.substring(0, 8)           + '...' : 'AUSENTE',
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET    ? process.env.X_ACCESS_TOKEN_SECRET.substring(0, 8)    + '...' : 'AUSENTE',
});

// ─────────────────────────────────────────────
// Primitivos de publicação
// ─────────────────────────────────────────────

async function publishTweet(text) {
  const result = await rwClient.v2.tweet({ text });
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
    const result = await rwClient.v2.tweet(payload);
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

  const result = await rwClient.v2.tweet({
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

    default: {
      // opinion, question — post simples
      if (!post.content) throw new Error('Post sem conteudo');
      // Guard: se o texto ultrapassar 280 chars, divide em thread em vez de truncar
      if (post.content.length > 280) {
        const parts = splitIntoThread(post.content);
        if (parts && parts.length > 1) {
          console.warn(`[publisher] Tweet simples com ${post.content.length} chars → dividido em thread de ${parts.length} tweets automaticamente`);
          return publishThread(parts);
        }
      }
      return publishTweet(post.content);
    }
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
 * Divide texto longo em partes de até 280 chars para publicar como thread.
 * Quebra em parágrafos (dupla newline) e depois em sentenças — nunca corta no meio de uma frase.
 * Retorna null se o texto já couber em 280 chars.
 */
function splitIntoThread(text) {
  if (text.length <= 280) return null;

  const chunks = [];
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  for (const para of paragraphs) {
    if (para.length <= 280) {
      chunks.push(para);
      continue;
    }
    // Quebra parágrafo longo em sentenças
    const sentences = para.match(/[^.!?\n]+[.!?\n]+/g) || [para];
    let current = '';
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (candidate.length <= 280) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = sentence.trim().substring(0, 280); // fallback: corta só se sentença isolada for > 280
      }
    }
    if (current) chunks.push(current);
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Monta a URL do primeiro tweet publicado (para link direto).
 */
function tweetUrl(tweetId, username) {
  if (username) return `https://x.com/${username}/status/${tweetId}`;
  return `https://x.com/i/web/status/${tweetId}`;
}

module.exports = { publish, publishTweet, publishThread, publishPoll, normalizeIds, rawResponse, tweetUrl };
