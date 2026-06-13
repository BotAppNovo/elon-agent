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
  { minLikes: 500, minVelocity: 150, label: 'Passe 1 (viral)'  },
  { minLikes: 200, minVelocity:  60, label: 'Passe 2 (quente)' },
  { minLikes:  80, minVelocity:  20, label: 'Passe 3 (piso)'   },
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

// ─── Busca do pool (3 chamadas paginadas) ─────────────────────────────────────

async function fetchPool() {
  const query      = '(vida adulta OR alguém mais OR esqueci OR não aguento OR semana OR segunda OR tarefa OR pendência) lang:pt -is:retweet -is:reply';
  const start_time = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const baseParams = {
    max_results:    25,
    sort_order:     'relevancy',
    'tweet.fields': 'public_metrics,created_at,reply_settings',
    expansions:     'author_id',
    'user.fields':  'username',
    start_time,
  };

  const allTweets = [];
  const usersMap  = {};
  let   nextToken = undefined;

  for (let call = 1; call <= 3; call++) {
    const params = { ...baseParams };
    if (nextToken) params.next_token = nextToken;

    try {
      console.log(`[copilot] Chamada ${call}/3`);
      const response = await rwClient.v2.search(query, params);
      const tweets   = response.data?.data || [];
      (response.data?.includes?.users || []).forEach((u) => { usersMap[u.id] = u; });
      allTweets.push(...tweets);
      nextToken = response.data?.meta?.next_token;
      console.log(`[copilot] Chamada ${call}/3: ${tweets.length} tweets recebidos`);
      if (!nextToken) break;
    } catch (err) {
      const detail = err.data ? JSON.stringify(err.data) : err.message;
      console.error(`[copilot] Chamada ${call}/3 falhou: ${detail}`);
      break;
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

// ─── Pontuação de adaptabilidade (potencial da ponte) ─────────────────────────

async function scoreAdaptability(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content:
          `Este tweet viral receberá uma resposta humorística que conecta o assunto dele ao universo de: ` +
          `memória falha, cabeça cheia, esquecimento, rotina caótica. ` +
          `Dê nota 0-10 para o potencial dessa ponte funcionar naturalmente. ` +
          `Política, tragédia, religião, morte, polêmica sensível = 0. ` +
          `Zueira de cotidiano, trabalho, relacionamento, esporte, comportamento = geralmente 6+. ` +
          `Responda apenas o número.\n\nTweet: "${tweetText}"`,
      },
    ],
    max_tokens: 5,
    temperature: 0,
  });
  const raw   = (response.choices[0].message.content || '').trim();
  const score = parseFloat(raw);
  return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
}

// ─── Geração da resposta (a ponte está aqui) ──────────────────────────────────

const REPLY_SYSTEM_PROMPT = `Você responde um tweet viral como uma pessoa real do X brasileiro.

REGRA CENTRAL: sua resposta precisa funcionar PRIMEIRO como comentário sobre O QUE O TWEET DIZ — e então puxar, com humor natural, para o universo de memória falha, cabeça cheia, mil pendências ou rotina caótica. Se a ponte ficar forçada, responda SKIP.

ESTILO: primeira pessoa, zueira leve brasileira, máximo 180 caracteres, zero hashtags, zero links, zero menção a produto ou app.

EXEMPLOS:
- Tweet "não aguento mais essa semana e é terça" → "terça é o dia que o cérebro percebe que as pendências da segunda continuam todas vivas"
- Tweet "alguém mais sente que o dia tem 3 horas?" → "o meu tem 24, só que 21 são ocupadas lembrando do que esqueci nas outras 3"
- Tweet "quando você vira adulto ninguém avisa que você vai viver com medo de ter esquecido alguma coisa" → "e o pior é que você não lembra o que esqueceu mas sabe que esqueceu"
- Tweet "minha memória de trabalho: ótima. minha memória de fazer o que tenho que fazer: catastrófica" → "a competência cognitiva e a execução operacional brigam todo dia e quem perde é sempre a minha to-do list"
- Tweet "como pode ser segunda de novo" → "e já com 37 pendências na cabeça que sobreviveram ao final de semana"
- Tweet "meu cérebro no trabalho: incapaz. meu cérebro às 2h da manhã: lembrou de tudo que atrasou" → "e aí você fica acordado resolvendo mentalmente o que devia ter feito de dia"

PROIBIDO:
- Resposta genérica que serviria em qualquer tweet
- "Que interessante", "Concordo plenamente", "Já parou para pensar"
- Tom de marca, tom de coach, tom de consultoria
- Reformular o que o tweet já disse

Se a ponte não funcionar naturalmente: responda apenas SKIP (maiúsculas, nada mais).

Retorne APENAS o texto da resposta ou SKIP, sem aspas, sem prefixo.`;

async function generateReply(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: REPLY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Tweet para responder:\n"${tweetText}"\n\nGere uma resposta de no máximo 180 caracteres ou responda SKIP.`,
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

  // 6. Pontuação de adaptabilidade
  console.log(`[copilot] Pontuando ${top10.length} candidatos por adaptabilidade...`);
  const scored = [];
  for (const tweet of top10) {
    let score = 6; // fallback otimista se IA falhar
    try {
      score = await scoreAdaptability(tweet.text);
    } catch (err) {
      console.error(`[copilot] Erro ao pontuar ${tweet.id}:`, err.message);
    }
    const velocity = calcVelocity(tweet);
    const likes    = tweet.public_metrics?.like_count ?? 0;
    console.log(`[copilot] Tweet ${tweet.id} — score: ${score} · ${likes} likes · ${velocity.toFixed(1)}/h`);
    scored.push({ tweet, score, velocity });
  }

  // Ordenar: score×100 + velocidade (maior primeiro)
  scored.sort((a, b) => (b.score * 100 + b.velocity) - (a.score * 100 + a.velocity));

  // 7. Aprovação e geração: ≥6 sempre; 4-5 só se <5 aprovados; <4 descarta
  let approvedCount  = 0;
  let suggestionsSent = 0;

  for (const { tweet, score, velocity } of scored) {
    if (score < 4) {
      console.log(`[copilot] Tweet ${tweet.id} — score ${score} < 4, descartado.`);
      continue;
    }
    if (score < 6 && approvedCount >= 5) {
      console.log(`[copilot] Tweet ${tweet.id} — score ${score} (4-5) mas já ${approvedCount} aprovados, pulando.`);
      continue;
    }

    try {
      const replyText = await generateReply(tweet.text);

      if (!replyText || replyText.toUpperCase() === 'SKIP') {
        console.log(`[copilot] Tweet ${tweet.id} — resposta SKIP, descartado.`);
        await saveSuggestedTweet(tweet.id, 'SKIP');
        continue;
      }

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

      approvedCount++;
      suggestionsSent++;
      console.log(`[copilot] Sugestão enviada — tweet ${tweet.id} (score: ${score}, vel: ${velocity.toFixed(1)}/h)`);
    } catch (err) {
      console.error(`[copilot] Erro ao processar tweet ${tweet.id}:`, err.message);
    }
  }

  if (suggestionsSent === 0 && telegram && OWNER_CHAT_ID) {
    const top = scored[0];
    let diagMsg = `📊 ${pool.length} tweets analisados.`;
    if (top) {
      diagMsg += ` Melhor candidato: ${top.tweet.public_metrics?.like_count ?? 0} likes, ${top.velocity.toFixed(1)}/h.`;
    }
    diagMsg += ` Nenhuma sugestão enviada (todos descartados por SKIP ou score insuficiente).`;
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
