'use strict';

const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const {
  getSetting,
  isTweetSuggested,
  saveSuggestedTweet,
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

// copilotId -> { tweetId, tweetText, tweetUrl, authorUsername, metrics, velocity, suggestedReply, quoteText, quoteIntentUrl, messageId }
const copilotPendingApprovals = new Map();

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const X_USERNAME = process.env.X_USERNAME || null;

// ─── Cascata de thresholds ───────────────────────────────────────────────────

const CASCADE_PASSES = [
  { minLikes: 1000, minVelocity: 300, label: 'Passe 1 (viral)'  },
  { minLikes:  300, minVelocity:  80, label: 'Passe 2 (quente)' },
  { minLikes:   50, minVelocity:  15, label: 'Passe 3 (piso)'   },
];

// ─── Velocidade de engajamento (likes/hora) ───────────────────────────────────

function calcVelocity(tweet) {
  if (!tweet.created_at) return 0;
  const hoursElapsed = Math.max(
    (Date.now() - new Date(tweet.created_at).getTime()) / (1000 * 60 * 60),
    0.1
  );
  return (tweet.public_metrics?.like_count ?? 0) / hoursElapsed;
}

// ─── Queries rotativas (palavras mais comuns do PT — garante volume alto) ────────

const POOL_QUERIES = [
  '(eu OR vc OR você OR minha OR meu) lang:pt -is:retweet -is:reply',
  '(hoje OR agora OR essa OR esse OR aqui) lang:pt -is:retweet -is:reply',
  '(gente OR cara OR mano OR amigo OR pessoal) lang:pt -is:retweet -is:reply',
  '(não OR nunca OR sempre OR ainda OR já) lang:pt -is:retweet -is:reply',
  '(que OR como OR quando OR porque OR mas) lang:pt -is:retweet -is:reply',
];

// Índice de rotação persistido em memória (avança a cada execução)
let _queryRotationIndex = 0;

// ─── Busca do pool (3 queries em paralelo, rotacionando) ─────────────────────

async function fetchPool() {
  const start_time = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const baseParams = {
    max_results:    25,
    sort_order:     'relevancy',
    'tweet.fields': 'public_metrics,created_at,reply_settings',
    expansions:     'author_id',
    'user.fields':  'username',
    start_time,
  };

  // Seleciona 3 queries consecutivas a partir do índice atual
  const selected = [0, 1, 2].map((offset) =>
    POOL_QUERIES[(_queryRotationIndex + offset) % POOL_QUERIES.length]
  );
  _queryRotationIndex = (_queryRotationIndex + 3) % POOL_QUERIES.length;

  console.log(`[copilot] Queries selecionadas: ${selected.map((q, i) => `Q${i + 1}`).join(', ')}`);

  // Executa as 3 queries em paralelo
  const results = await Promise.allSettled(
    selected.map((query, i) =>
      rwClient.v2.search(query, { ...baseParams }).then((response) => {
        const tweets = response.data?.data || [];
        const users  = response.data?.includes?.users || [];
        console.log(`[copilot] Query ${i + 1}/3: ${tweets.length} tweets`);
        return { tweets, users };
      })
    )
  );

  const allTweets = [];
  const usersMap  = {};

  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      allTweets.push(...result.value.tweets);
      result.value.users.forEach((u) => { usersMap[u.id] = u; });
    } else {
      const detail = result.reason?.data
        ? JSON.stringify(result.reason.data)
        : result.reason?.message;
      console.error(`[copilot] Query ${i + 1}/3 falhou: ${detail}`);
    }
  }

  // Deduplicar por ID
  const seen   = new Set();
  const unique = allTweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  console.log(`[copilot] Pool: ${allTweets.length} tweets → ${unique.length} únicos`);
  return { tweets: unique, usersMap };
}

// ─── Geração da resposta ──────────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `Você responde tweets virais como uma pessoa espirituosa e real do X brasileiro. Sempre gere uma resposta — nunca recuse.

PRIORIDADE 1: se houver conexão natural com memória falha, cabeça cheia, esquecimento ou rotina caótica, faça essa ponte com humor ou observação afiada.

PRIORIDADE 2: se não houver conexão óbvia, faça uma resposta genuinamente engraçada ou perspicaz sobre o que o tweet diz — uma resposta boa que faça as pessoas quererem ver quem respondeu.

REGRAS:
- Primeira pessoa, voz humana, zero robótico
- Máximo 180 caracteres
- Zero hashtags, zero links, no máximo 1 emoji
- NUNCA mencionar Myndit, app ou produto
- Nunca responder SKIP — sempre gere algo
- NUNCA começar com "Que lindo!", "Que incrível!", "Adorei", "Que demais" — soa falso
- NUNCA usar emoji verde 💚 ou qualquer emoji de marca
- Começar com letra minúscula quando o tom for casual — é assim que o brasileiro real escreve no X
- O humor deve ser seco, inteligente ou autodepreciativo — nunca entusiasmado

TOM CERTO:
Tweet: 'saudade' → 'o coração lembra de tudo que a cabeça tenta esquecer'
Tweet: 'namorado perfeito' → 'namorado bom é o que lembra dos detalhes sem precisar de lembrete'
Tweet: 'minha memória afetiva' → 'sorte sua, a minha é seletiva demais'
Tweet: 'brasil perdeu' → 'perder dói menos que lembrar que eu apostei no brasil'
Tweet: 'não aguento mais segunda' → 'o pior da segunda é lembrar de tudo que eu disse que ia fazer na sexta'
Tweet: 'que calor absurdo' → 'meu cérebro derreteu junto e agora não lembro nem o que ia fazer hoje'
Tweet: 'alguém me explica adultos' → 'a gente não sabe, só fica fingindo que lembra de tudo que precisa fazer'
Tweet: 'novo iPhone saiu' → 'vou comprar e esquecer a senha no primeiro dia como de costume'

Retorne APENAS o texto da resposta, sem aspas, sem prefixo.`;

async function generateReply(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: REPLY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Tweet para responder:\n"${tweetText}"\n\nGere uma resposta de no máximo 180 caracteres.`,
      },
    ],
    max_tokens: 100,
    temperature: 0.85,
  });
  return (response.choices[0].message.content || '').trim().substring(0, 200);
}

// ─── Geração de quote tweet ───────────────────────────────────────────────────

const QUOTE_SYSTEM_PROMPT = `Você é a voz do perfil do Myndit no X. Você faz quote tweets como uma PESSOA real, nunca como uma marca.

REGRAS DE OURO:
1. Escreva como brasileiro fala no X: informal, direto, com personalidade
2. Você comenta o tema do tweet, não responde ao autor — o texto deve fazer sentido isolado
3. Varie entre: ampliar o ponto com exagero cômico, contar micro-história em 1 frase, virar a perspectiva, dar opinião contrária leve
4. Máximo 180 caracteres. Mais curto geralmente performa melhor
5. Zero hashtags, zero links, no máximo 1 emoji (de preferência nenhum)
6. NUNCA mencione o Myndit, app, produto ou solução. Você é só uma pessoa na conversa

PROIBIDO:
- Frases genéricas que caberiam em qualquer tweet sobre o tema
- "Que interessante", "Muito bom isso", "Exatamente isso"
- Tom de marca, tom de consultoria, tom de coach
- Reformular o que o tweet já disse

Retorne APENAS o texto, sem aspas, sem prefixo.`;

async function generateQuote(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: QUOTE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Tweet a ser citado:\n"${tweetText}"\n\nGere um comentário de no máximo 200 caracteres.`,
      },
    ],
    max_tokens: 100,
    temperature: 0.85,
  });
  return (response.choices[0].message.content || '').trim().substring(0, 200);
}

// ─── Helpers de UI ────────────────────────────────────────────────────────────

function buildIntentUrl(tweetId, replyText) {
  return `https://x.com/intent/post?in_reply_to=${tweetId}&text=${encodeURIComponent(replyText)}`;
}

function buildQuoteIntentUrl(tweetId, authorUsername, quoteText) {
  const originalUrl = `https://x.com/${authorUsername}/status/${tweetId}`;
  return `https://x.com/intent/post?text=${encodeURIComponent(quoteText + ' ' + originalUrl)}`;
}

function copilotKeyboard(copilotId, intentUrl, quoteIntentUrl) {
  return {
    inline_keyboard: [
      [
        { text: '💬 Responder', url: intentUrl },
        { text: '🔁 Citar',    url: quoteIntentUrl },
      ],
      [
        { text: '✏️ Editar', callback_data: `copilot_edit:${copilotId}` },
        { text: '❌ Pular',  callback_data: `copilot_skip:${copilotId}` },
      ],
    ],
  };
}

function buildSuggestionMessage(tweetText, tweetUrl, authorUsername, metrics, velocity, suggestedReply, edited = false) {
  const header  = edited ? `🎯 <b>Copiloto — Sugestão editada</b>` : `🎯 <b>Copiloto — Sugestão de resposta</b>`;
  const rts     = (metrics?.retweet_count ?? 0) + (metrics?.quote_count ?? 0);
  const vel     = typeof velocity === 'number' ? velocity.toFixed(1) : '0.0';
  const snippet = escHtml(tweetText.substring(0, 200));
  return (
    `${header}\n\n` +
    `<b>Tweet:</b> <i>${snippet}${tweetText.length > 200 ? '…' : ''}</i>\n` +
    `<b>@${escHtml(authorUsername)}</b> · ❤️ ${metrics?.like_count ?? 0} · 🔁 ${rts} · 🔥 ${vel}/h\n` +
    `🔗 <a href="${tweetUrl}">Ver no X</a>\n\n` +
    `<b>Resposta sugerida:</b>\n${escHtml(suggestedReply)}`
  );
}

// ─── Busca principal ──────────────────────────────────────────────────────────

async function runCopilotSearch(telegram) {
  const enabled = (await getSetting('copilot_enabled')) !== 'false';
  if (!enabled) {
    console.log('[copilot] Desativado — busca ignorada.');
    return { suggestionsSent: 0 };
  }

  // 1. Buscar pool de até 75 tweets (3 chamadas paginadas)
  let pool, usersMap;
  try {
    ({ tweets: pool, usersMap } = await fetchPool());
  } catch (err) {
    console.error('[copilot] Erro fatal na busca:', err.message);
    if (telegram && OWNER_CHAT_ID) {
      await telegram.sendMessage(OWNER_CHAT_ID, `⚠️ Copiloto: erro na busca — ${err.message}`).catch(() => {});
    }
    return { suggestionsSent: 0 };
  }

  console.log(`[copilot] Funil: ${pool.length} tweets no pool`);

  // 2. Filtrar reply_settings === 'everyone'
  const openReplies = pool.filter((t) => t.reply_settings === 'everyone');
  console.log(`[copilot] Após filtro reply_settings=everyone: ${openReplies.length}`);

  // 3. Remover já sugeridos
  const unseen = [];
  for (const t of openReplies) {
    if (!(await isTweetSuggested(t.id))) unseen.push(t);
  }
  console.log(`[copilot] Após filtro já sugeridos: ${unseen.length}`);

  // 4. Cascata de thresholds
  let candidates   = [];
  let passUsed     = null;
  let bestRejected = null;

  for (const pass of CASCADE_PASSES) {
    const passing = unseen.filter((t) => {
      const likes = t.public_metrics?.like_count ?? 0;
      const vel   = calcVelocity(t);
      const ok    = likes >= pass.minLikes || vel >= pass.minVelocity;
      if (!ok && (!bestRejected || likes > bestRejected.likes)) {
        bestRejected = { likes, velocity: parseFloat(vel.toFixed(1)) };
      }
      return ok;
    });
    console.log(`[copilot] ${pass.label}: ${passing.length} tweets passaram`);
    if (passing.length > 0) {
      candidates = passing;
      passUsed   = pass.label;
      break;
    }
  }

  if (candidates.length === 0) {
    console.log('[copilot] Nenhum tweet atingiu o piso de engajamento.');
    if (telegram && OWNER_CHAT_ID) {
      let diagMsg = `📊 ${pool.length} tweets analisados.`;
      if (bestRejected) {
        diagMsg += ` Melhor candidato: ${bestRejected.likes} likes, ${bestRejected.velocity}/h.`;
      }
      diagMsg += ` Nenhum atingiu o piso mínimo (80 likes ou 20/h).`;
      await telegram.sendMessage(OWNER_CHAT_ID, diagMsg).catch(() => {});
    }
    return { suggestionsSent: 0 };
  }

  // 5. TOP 10 por velocidade
  const top10 = candidates
    .sort((a, b) => calcVelocity(b) - calcVelocity(a))
    .slice(0, 10);
  console.log(`[copilot] Top 10 por velocidade selecionados (${passUsed})`);

  // 6. Geração de respostas para todos os top10
  let suggestionsSent = 0;

  for (const tweet of top10) {
    const velocity = calcVelocity(tweet);
    try {
      const replyText = await generateReply(tweet.text);

      const author         = usersMap[tweet.author_id];
      const authorUsername = author?.username || 'i/web';
      const tweetUrl       = `https://x.com/${authorUsername}/status/${tweet.id}`;
      const quoteText      = await generateQuote(tweet.text);
      const intentUrl      = buildIntentUrl(tweet.id, replyText);
      const quoteIntentUrl = buildQuoteIntentUrl(tweet.id, authorUsername, quoteText);

      await saveSuggestedTweet(tweet.id, replyText);

      const copilotId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const message = await telegram.sendMessage(
        OWNER_CHAT_ID,
        buildSuggestionMessage(tweet.text, tweetUrl, authorUsername, tweet.public_metrics, velocity, replyText),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: copilotKeyboard(copilotId, intentUrl, quoteIntentUrl),
        }
      );

      copilotPendingApprovals.set(copilotId, {
        tweetId:        tweet.id,
        tweetText:      tweet.text,
        tweetUrl,
        authorUsername,
        metrics:        tweet.public_metrics,
        velocity,
        suggestedReply: replyText,
        quoteText,
        quoteIntentUrl,
        messageId:      message.message_id,
      });

      suggestionsSent++;
      console.log(`[copilot] Sugestão enviada — tweet ${tweet.id} (vel: ${velocity.toFixed(1)}/h)`);
    } catch (err) {
      console.error(`[copilot] Erro ao processar tweet ${tweet.id}:`, err.message);
    }
  }

  if (suggestionsSent === 0 && telegram && OWNER_CHAT_ID) {
    const best = top10[0];
    let diagMsg = `📊 ${pool.length} tweets analisados.`;
    if (best) {
      diagMsg += ` Melhor candidato: ${best.public_metrics?.like_count ?? 0} likes, ${calcVelocity(best).toFixed(1)}/h.`;
    }
    diagMsg += ` Nenhuma sugestão enviada (erro na geração).`;
    await telegram.sendMessage(OWNER_CHAT_ID, diagMsg).catch(() => {});
  }

  return { suggestionsSent };
}

async function skipTweet(tweetId) {
  await markTweetSkipped(tweetId);
}

// ─── Iniciar cron ─────────────────────────────────────────────────────────────

function startCopilot(telegram) {
  cron.schedule(
    '0 7 * * *',
    async () => {
      try {
        await runCopilotSearch(telegram);
      } catch (e) {
        console.error('[copilot] Erro cron 7h:', e.message);
      }
    },
    { timezone: 'America/Sao_Paulo' }
  );

  console.log('[copilot] Agendado: 7h (America/Sao_Paulo)');
}

module.exports = {
  startCopilot,
  runCopilotSearch,
  copilotPendingApprovals,
  copilotKeyboard,
  buildSuggestionMessage,
  buildIntentUrl,
  buildQuoteIntentUrl,
  skipTweet,
};
