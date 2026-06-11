'use strict';

const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const {
  getSetting,
  isTweetSuggested,
  saveSuggestedTweet,
  markTweetReplied,
  markTweetSkipped,
} = require('./db');
const { escHtml } = require('./utils');

// ─── Twitter client ───────────────────────────────────────────────────────────

const _client = new TwitterApi({
  appKey:       process.env.X_CLIENT_ID,
  appSecret:    process.env.X_CLIENT_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});
const rwClient = _client.readWrite;

// ─── OpenAI client ────────────────────────────────────────────────────────────

let _openai;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Estado em memória ────────────────────────────────────────────────────────

// copilotId -> { tweetId, tweetText, tweetUrl, metrics, suggestedReply, messageId }
const copilotPendingApprovals = new Map();

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const X_USERNAME = process.env.X_USERNAME || null;

// ─── Grupos de palavras-chave (rotação a cada busca) ─────────────────────────

const KEYWORD_GROUPS = [
  'produtividade',
  'esquecer OR esqueci',
  'carga mental',
  'rotina corrida',
  'ansiedade tarefas',
  'memória cheia',
];
let keywordGroupIndex = 0;

// ─── Filtro de relevância via IA ──────────────────────────────────────────────

async function isRelevant(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content:
          `Avalie se este tweet tem relação REAL com os temas: produtividade pessoal, ` +
          `esquecimento de tarefas, sobrecarga mental, rotina corrida, organização pessoal, ` +
          `ansiedade por pendências. Tweets sobre política, economia, notícias, esportes ou ` +
          `qualquer tema que apenas mencione essas palavras em outro contexto devem ser REJEITADOS. ` +
          `Responda apenas APROVADO ou REJEITADO.\n\nTweet: "${tweetText}"`,
      },
    ],
    max_tokens: 10,
    temperature: 0,
  });
  const verdict = (response.choices[0].message.content || '').trim().toUpperCase();
  return verdict.includes('APROVADO');
}

// ─── Geração da resposta ─────────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `Você gera respostas curtas para tweets em português sobre produtividade, esquecimento, carga mental e rotina.

REGRAS ABSOLUTAS:
1. Primeira pessoa — você fala como o dono do perfil, uma pessoa real
2. Português brasileiro natural e informal — como uma mensagem de WhatsApp inteligente
3. NUNCA técnico, corporativo ou comercial
4. Varie entre dois estilos: (a) agrega contexto ou opinião com identificação imediata, (b) pergunta provocativa que gera resposta
5. Máximo 200 caracteres — conte antes de responder
6. Zero hashtags, zero links
7. No máximo 1 emoji — e só se fizer sentido real
8. NUNCA mencionar o Myndit, nunca fazer propaganda, nunca citar produto algum
9. A resposta deve fazer sentido para quem lê o tweet original — não seja genérica

Retorne APENAS o texto da resposta, sem aspas, sem prefixo.`;

async function generateReply(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: REPLY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Tweet para responder:\n"${tweetText}"\n\nGere uma resposta de no máximo 200 caracteres.`,
      },
    ],
    max_tokens: 100,
    temperature: 0.85,
  });
  return (response.choices[0].message.content || '').trim().substring(0, 200);
}

// ─── Helpers de UI ────────────────────────────────────────────────────────────

function copilotKeyboard(copilotId) {
  return {
    inline_keyboard: [[
      { text: '✅ Responder', callback_data: `copilot_reply:${copilotId}` },
      { text: '✏️ Editar',    callback_data: `copilot_edit:${copilotId}` },
      { text: '❌ Pular',     callback_data: `copilot_skip:${copilotId}` },
    ]],
  };
}

function buildSuggestionMessage(tweetText, tweetUrl, metrics, suggestedReply, edited = false) {
  const header = edited
    ? `🎯 <b>Copiloto — Sugestão editada</b>`
    : `🎯 <b>Copiloto — Sugestão de resposta</b>`;
  const rts = (metrics.retweet_count || 0) + (metrics.quote_count || 0);
  return (
    `${header}\n\n` +
    `<b>Tweet original:</b>\n<i>${escHtml(tweetText)}</i>\n\n` +
    `🔗 <a href="${tweetUrl}">Ver tweet</a> · ❤️ ${metrics.like_count} · 🔁 ${rts}\n\n` +
    `<b>Resposta sugerida:</b>\n${escHtml(suggestedReply)}`
  );
}

// ─── Busca principal ─────────────────────────────────────────────────────────

async function runCopilotSearch(telegram) {
  const enabled = (await getSetting('copilot_enabled')) !== 'false';
  if (!enabled) {
    console.log('[copilot] Desativado — busca ignorada.');
    return;
  }

  const keywords = KEYWORD_GROUPS[keywordGroupIndex % KEYWORD_GROUPS.length];
  keywordGroupIndex = (keywordGroupIndex + 1) % KEYWORD_GROUPS.length;

  const query = `(${keywords}) lang:pt -is:retweet -is:reply`;
  console.log(`[copilot] Buscando: ${query}`);

  const response = await rwClient.v2.search(query, {
    max_results: 20,
    'tweet.fields': 'public_metrics,created_at,author_id',
    expansions: 'author_id',
    'user.fields': 'username',
  });

  const tweets = response.data?.data || [];
  const usersMap = {};
  (response.data?.includes?.users || []).forEach((u) => { usersMap[u.id] = u; });

  // Filtro: últimas 12h + engajamento mínimo
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const filtered = tweets.filter((t) => {
    const created = new Date(t.created_at);
    if (created < cutoff) return false;
    const m = t.public_metrics;
    return m.like_count >= 50 || (m.retweet_count + (m.quote_count || 0)) >= 10;
  });

  // Ordenar por engajamento (likes + 3× RTs/quotes)
  filtered.sort((a, b) => {
    const score = (t) =>
      t.public_metrics.like_count +
      3 * (t.public_metrics.retweet_count + (t.public_metrics.quote_count || 0));
    return score(b) - score(a);
  });

  // Top 3, excluindo já sugeridos/respondidos
  const selected = [];
  for (const tweet of filtered) {
    if (selected.length >= 3) break;
    if (!(await isTweetSuggested(tweet.id))) selected.push(tweet);
  }

  console.log(
    `[copilot] ${tweets.length} encontrados → ${filtered.length} elegíveis → ${selected.length} selecionados`
  );

  // Filtro de relevância via IA
  const relevant = [];
  for (const tweet of selected) {
    try {
      const ok = await isRelevant(tweet.text);
      console.log(`[copilot] Tweet ${tweet.id} — ${ok ? 'APROVADO' : 'REJEITADO'} pela IA`);
      if (ok) relevant.push(tweet);
    } catch (err) {
      console.error(`[copilot] Erro ao avaliar relevância do tweet ${tweet.id}:`, err.message);
      relevant.push(tweet); // em caso de falha da IA, não bloquear
    }
  }

  if (relevant.length === 0) {
    console.log('[copilot] Nenhum tweet relevante após filtro de IA.');
    if (telegram && OWNER_CHAT_ID) {
      await telegram
        .sendMessage(OWNER_CHAT_ID, '🔍 Nenhum tweet relevante encontrado nesta busca.')
        .catch(() => {});
    }
    return;
  }

  for (const tweet of relevant) {
    try {
      const author = usersMap[tweet.author_id];
      const tweetUrl = `https://x.com/${author?.username || 'i/web'}/status/${tweet.id}`;
      const suggestedReply = await generateReply(tweet.text);

      await saveSuggestedTweet(tweet.id, suggestedReply);

      const copilotId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const message = await telegram.sendMessage(
        OWNER_CHAT_ID,
        buildSuggestionMessage(tweet.text, tweetUrl, tweet.public_metrics, suggestedReply),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: copilotKeyboard(copilotId),
        }
      );

      copilotPendingApprovals.set(copilotId, {
        tweetId: tweet.id,
        tweetText: tweet.text,
        tweetUrl,
        metrics: tweet.public_metrics,
        suggestedReply,
        messageId: message.message_id,
      });

      console.log(`[copilot] Sugestão enviada — tweet ${tweet.id}`);
    } catch (err) {
      console.error(`[copilot] Erro ao processar tweet ${tweet.id}:`, err.message);
    }
  }
}

// ─── Publicar resposta ────────────────────────────────────────────────────────

async function replyTweet(tweetId, replyText) {
  const id = String(tweetId); // IDs do X perdem precisão como número
  const result = await rwClient.v2.tweet(replyText, {
    reply: { in_reply_to_tweet_id: id },
  });
  await markTweetReplied(id, result.data.id);
  return result.data;
}

async function skipTweet(tweetId) {
  await markTweetSkipped(tweetId);
}

// ─── Iniciar crons ────────────────────────────────────────────────────────────

function startCopilot(telegram) {
  cron.schedule(
    '0 11 * * *',
    () => runCopilotSearch(telegram).catch((e) => console.error('[copilot] Erro cron 11h:', e.message)),
    { timezone: 'America/Sao_Paulo' }
  );
  cron.schedule(
    '0 19 * * *',
    () => runCopilotSearch(telegram).catch((e) => console.error('[copilot] Erro cron 19h:', e.message)),
    { timezone: 'America/Sao_Paulo' }
  );
  console.log('[copilot] Agendado: 11h e 19h (America/Sao_Paulo)');
}

module.exports = {
  startCopilot,
  runCopilotSearch,
  copilotPendingApprovals,
  copilotKeyboard,
  buildSuggestionMessage,
  replyTweet,
  skipTweet,
};
