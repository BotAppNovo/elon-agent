'use strict';

const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const {
  getSetting,
  saveSetting,
  isTweetSuggested,
  saveSuggestedTweet,
  markTweetSkipped,
  getActiveTrends,
} = require('./db');
const { fetchAndStoreTrends } = require('./trends');
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

// copilotId -> { tweetId, tweetText, tweetUrl, authorUsername, metrics, suggestedReply, quoteText, quoteIntentUrl, messageId }
const copilotPendingApprovals = new Map();

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const X_USERNAME = process.env.X_USERNAME || null;

// ─── Redes de captura viral ───────────────────────────────────────────────────
// Queries amplas + sort_order=relevancy = tweets mais quentes do momento.
// Cada execução usa 2 redes em rotação (índice persistido no banco como copilot_net_index).

const VIRAL_NETS = [
  // Rede 1 — expressões universais de queixa/cumplicidade
  '"alguém mais" OR "só eu que" OR "não aguento"',
  // Rede 2 — marcadores de informalidade viral
  '"gente" OR "véi" OR "mano do céu"',
  // Rede 3 — narrativa pessoal do dia
  '"eu hoje" OR "meu dia" OR "essa semana"',
  // Rede 4 — incredulidade e indignação
  '"por que ninguém" OR "como assim" OR "não acredito"',
  // Rede 5 — rotina e trabalho
  '"vida adulta" OR "trabalhar cansa" OR "segunda-feira"',
];

// Cascata de thresholds — aplicada sobre o pool combinado das 2 redes.
// Percorre do mais exigente ao piso; abaixo do piso, nunca sugere.
const CASCADE_PASSES = [
  { minLikes: 300, minVelocity: 100, label: 'Passe 1 (viral)'  },
  { minLikes: 150, minVelocity:  40, label: 'Passe 2 (quente)' },
  { minLikes:  80, minVelocity:  20, label: 'Passe 3 (piso)'   },
];

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
  const raw = (response.choices[0].message.content || '').trim();
  const score = parseFloat(raw);
  return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
}

// ─── Geração da resposta (a ponte está aqui) ──────────────────────────────────

const REPLY_SYSTEM_PROMPT = `Você responde um tweet viral como uma pessoa real do X brasileiro.

REGRA CENTRAL: sua resposta precisa funcionar PRIMEIRO como comentário sobre O QUE O TWEET DIZ — e então puxar, com humor natural, para o universo de memória falha, cabeça cheia, mil pendências ou rotina caótica. Se a ponte ficar forçada, responda SKIP.

ESTILO: primeira pessoa, zueira leve brasileira, máximo 180 caracteres, zero hashtags, zero links, zero menção a produto ou app.

EXEMPLOS:
- Tweet: "não aguento mais essa semana e é terça" → "terça é o dia que o cérebro percebe que as pendências da segunda continuam todas vivas"
- Tweet: "alguém mais sente que o dia tem 3 horas?" → "o meu tem 24, só que 21 são ocupadas lembrando do que esqueci nas outras 3"

PROIBIDO:
- Resposta genérica que serviria em qualquer tweet
- "Que interessante", "Concordo plenamente", "Já parou para pensar"
- Tom de marca, tom de coach, tom de consultoria
- Reformular o que o tweet já disse

Se a ponte não funcionar naturalmente: responda apenas SKIP (maiúsculas, nada mais).

Retorne APENAS o texto da resposta ou SKIP, sem aspas, sem prefixo.`;

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

// Gera a resposta com lógica de SKIP — retorna o texto ou 'SKIP'
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

// ─── Resposta para tweets de trend ───────────────────────────────────────────

const TREND_REPLY_SYSTEM_PROMPT = `Você responde um tweet viral de um trending topic do Brasil. Sua missão: fazer humor conectando o assunto do tweet ao universo de esquecimento, memória falha, cabeça cheia ou rotina caótica — a lente do perfil.

REGRAS:
1. A piada tem que funcionar PRIMEIRO como piada — se não fizer rir ou sorrir, não serve
2. A conexão com o tema de memória/cabeça cheia precisa ser natural, não forçada
3. Se não houver conexão natural possível, responda exatamente: SKIP
4. Estilo: zueira brasileira do X, primeira pessoa, direto, informal
5. Máximo 180 caracteres
6. Zero hashtags, zero links, zero menção a produto ou marca
7. No máximo 1 emoji (de preferência nenhum)

EXEMPLOS DE TOM CERTO:
- Tweet sobre jogo da Copa: "marquei 3 alarmes pra não perder o jogo e quase esqueci mesmo assim. minha cabeça não colabora nem com o que eu gosto"
- Tweet de meme comportamental: "entendo. eu também acredito em milagre toda segunda que acho que vou fazer tudo que adiando desde março"

Se não der pra conectar com naturalidade: responda apenas SKIP (em maiúsculas, sem mais nada).

Retorne APENAS o texto da resposta ou SKIP, sem aspas, sem prefixo.`;

async function generateTrendReply(tweetText, trendName, angle) {
  const angleHint = angle ? `\n\nÂngulo sugerido para conexão: ${angle}` : '';
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: TREND_REPLY_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Trend: ${trendName}${angleHint}\n\n` +
          `Tweet para responder:\n"${tweetText}"\n\n` +
          `Gere uma resposta de no máximo 180 caracteres ou responda SKIP.`,
      },
    ],
    max_tokens: 120,
    temperature: 0.85,
  });
  return (response.choices[0].message.content || '').trim();
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
        { text: '💬 Responder no X', url: intentUrl },
        { text: '🔁 Citar no X',     url: quoteIntentUrl },
      ],
      [
        { text: '✏️ Editar', callback_data: `copilot_edit:${copilotId}` },
        { text: '❌ Pular',  callback_data: `copilot_skip:${copilotId}` },
      ],
    ],
  };
}

function buildSuggestionMessage(tweetText, tweetUrl, metrics, suggestedReply, edited = false, trendName = null) {
  let header;
  if (trendName) {
    header = edited
      ? `🔥 <b>Trend: ${escHtml(trendName)} — Sugestão editada</b>`
      : `🔥 <b>Trend: ${escHtml(trendName)}</b>`;
  } else {
    header = edited
      ? `🎯 <b>Copiloto — Sugestão editada</b>`
      : `🎯 <b>Copiloto — Sugestão de resposta</b>`;
  }
  const rts = (metrics.retweet_count || 0) + (metrics.quote_count || 0);
  return (
    `${header}\n\n` +
    `<b>Tweet original:</b>\n<i>${escHtml(tweetText)}</i>\n\n` +
    `🔗 <a href="${tweetUrl}">Ver tweet</a> · ❤️ ${metrics.like_count} · 🔁 ${rts}\n\n` +
    `<b>Resposta sugerida:</b>\n${escHtml(suggestedReply)}`
  );
}

// ─── Velocidade de engajamento (likes/hora) ───────────────────────────────────

function calcVelocity(tweet) {
  if (!tweet.created_at) return 0;
  const hoursElapsed = Math.max(
    (Date.now() - new Date(tweet.created_at).getTime()) / (1000 * 60 * 60),
    0.1
  );
  return (tweet.public_metrics?.like_count ?? 0) / hoursElapsed;
}

// ─── Busca de uma rede viral ──────────────────────────────────────────────────

// Retorna { tweets, usersMap, totalReturned, netLabel, error }
// Nunca lança — captura erros e os retorna para diagnóstico.
async function fetchNet(netIndex, netLabel) {
  const keywords = VIRAL_NETS[netIndex];
  const query = `(${keywords}) lang:pt -is:retweet -is:reply`;
  const searchParams = {
    max_results: 25,
    sort_order: 'relevancy',
    'tweet.fields': 'public_metrics,created_at,reply_settings',
    expansions: 'author_id',
    'user.fields': 'username',
  };

  console.log(`[copilot] Rede ${netLabel}: query: "${query}"`);
  console.log(`[copilot] Rede ${netLabel}: params: ${JSON.stringify(searchParams)}`);

  let response;
  try {
    response = await rwClient.v2.search(query, searchParams);
  } catch (err) {
    const detail = err.data ? JSON.stringify(err.data) : err.message;
    console.error(`[copilot] Rede ${netLabel} erro de API: ${detail}`);
    return { tweets: [], usersMap: {}, totalReturned: 0, netLabel, error: detail };
  }

  const tweets = response.data?.data || [];
  const usersMap = {};
  (response.data?.includes?.users || []).forEach((u) => { usersMap[u.id] = u; });

  console.log(`[copilot] Rede ${netLabel}: ${tweets.length} tweets retornados`);

  return { tweets, usersMap, totalReturned: tweets.length, netLabel, error: null };
}

// ─── Busca de tweets de um trend específico ───────────────────────────────────

async function fetchTrendTweets(trendName) {
  const safeTrend = trendName.replace(/"/g, '');
  const query = `"${safeTrend}" lang:pt -is:retweet -is:reply`;
  console.log(`[copilot/trend] Buscando tweets do trend "${trendName}"`);

  const response = await rwClient.v2.search(query, {
    max_results: 25,
    sort_order: 'relevancy',
    'tweet.fields': 'public_metrics,created_at,author_id',
    expansions: 'author_id',
    'user.fields': 'username',
  });

  const tweets = response.data?.data || [];
  const usersMap = {};
  (response.data?.includes?.users || []).forEach((u) => { usersMap[u.id] = u; });

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const filtered = tweets.filter((t) => {
    if (!t.created_at || new Date(t.created_at) < cutoff) return false;
    const likes    = t.public_metrics?.like_count ?? 0;
    const velocity = calcVelocity(t);
    return likes >= 80 || velocity >= 20;
  });

  filtered.sort((a, b) => calcVelocity(b) - calcVelocity(a));

  const selected = [];
  for (const tweet of filtered) {
    if (selected.length >= 3) break;
    if (!(await isTweetSuggested(tweet.id))) selected.push(tweet);
  }

  console.log(
    `[copilot/trend] "${trendName}": ${tweets.length} encontrados → ${filtered.length} elegíveis → ${selected.length} candidatos`
  );

  return { selected, usersMap };
}

// ─── Busca principal ──────────────────────────────────────────────────────────

// Retorna { suggestionsSent } para que o chamador saiba se enviou sugestões.
async function runCopilotSearch(telegram) {
  const enabled = (await getSetting('copilot_enabled')) !== 'false';
  if (!enabled) {
    console.log('[copilot] Desativado — busca ignorada.');
    return { suggestionsSent: 0 };
  }

  // Ler índice da rede (0–4), selecionar 2 redes consecutivas e avançar
  const rawNetIdx = await getSetting('copilot_net_index');
  let netIdx = rawNetIdx !== null ? parseInt(rawNetIdx, 10) : 0;
  if (isNaN(netIdx) || netIdx < 0) netIdx = 0;

  const netAIdx   = netIdx % VIRAL_NETS.length;
  const netBIdx   = (netIdx + 1) % VIRAL_NETS.length;
  const netALabel = String(netAIdx + 1);
  const netBLabel = String(netBIdx + 1);
  await saveSetting('copilot_net_index', String((netIdx + 2) % VIRAL_NETS.length));

  // Diagnóstico acumulado
  const diag = {
    totalTweets:  0,
    netsUsed:     [`Rede ${netALabel}`, `Rede ${netBLabel}`],
    apiErrors:    [],
    bestRejected: null, // { likes, velocity, reason }
    passUsed:     null,
  };

  // Buscar as 2 redes em paralelo
  const [resultA, resultB] = await Promise.all([
    fetchNet(netAIdx, netALabel),
    fetchNet(netBIdx, netBLabel),
  ]);

  if (resultA.error) diag.apiErrors.push(`Rede ${netALabel}: ${resultA.error}`);
  if (resultB.error) diag.apiErrors.push(`Rede ${netBLabel}: ${resultB.error}`);

  // Combinar e deduplicar por id
  const seenIds    = new Set();
  const allTweets  = [];
  const allUsersMap = { ...resultA.usersMap, ...resultB.usersMap };

  for (const tweet of [...resultA.tweets, ...resultB.tweets]) {
    if (!seenIds.has(tweet.id)) {
      seenIds.add(tweet.id);
      allTweets.push(tweet);
    }
  }

  diag.totalTweets = allTweets.length;
  console.log(`[copilot] Pool combinado: ${allTweets.length} tweets únicos (redes ${netALabel} + ${netBLabel})`);

  // Log top 5 por likes — confirma que public_metrics estão chegando
  const top5 = [...allTweets]
    .sort((a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0))
    .slice(0, 5);
  if (top5.length > 0) {
    const lines = top5.map((t) => {
      const likes = t.public_metrics?.like_count ?? 'N/A';
      const rts   = (t.public_metrics?.retweet_count ?? 0) + (t.public_metrics?.quote_count ?? 0);
      const ageMs = t.created_at ? Date.now() - new Date(t.created_at).getTime() : null;
      const age   = ageMs !== null ? (ageMs / (1000 * 60 * 60)).toFixed(1) : 'N/A';
      const vel   = ageMs !== null
        ? ((t.public_metrics?.like_count ?? 0) / Math.max(ageMs / (1000 * 60 * 60), 0.1)).toFixed(1)
        : 'N/A';
      const text  = (t.text ?? '').substring(0, 50).replace(/\n/g, ' ');
      return `  "${text}..." (likes:${likes}, RTs:${rts}, vel:${vel}/h, idade:${age}h)`;
    });
    console.log(`[copilot] Top 5 pré-filtro:\n${lines.join('\n')}`);
  }

  // Debug de velocidade no primeiro tweet com created_at
  const sample = allTweets.find((t) => t.created_at);
  if (sample) {
    const ageH  = ((Date.now() - new Date(sample.created_at).getTime()) / (1000 * 60 * 60)).toFixed(2);
    const likes = sample.public_metrics?.like_count ?? 'N/A';
    const vel   = likes !== 'N/A' ? (likes / Math.max(parseFloat(ageH), 0.1)).toFixed(2) : 'N/A';
    console.log(`[copilot] Ex. velocidade: tweet ${sample.id} | created_at=${sample.created_at} | likes=${likes} | idade=${ageH}h | vel=${vel}/h`);
  } else if (allTweets.length > 0) {
    console.warn('[copilot] NENHUM tweet tem created_at — public_metrics provavelmente ausentes');
  }

  // Janela de 24h
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const withinWindow = allTweets.filter((t) => t.created_at && new Date(t.created_at) >= cutoff24h);

  // Cascata de passes — do mais exigente ao piso
  let candidates = [];
  for (const pass of CASCADE_PASSES) {
    const passing = withinWindow.filter((t) => {
      const likes    = t.public_metrics?.like_count ?? 0;
      const velocity = calcVelocity(t);
      const ok = likes >= pass.minLikes || velocity >= pass.minVelocity;

      if (!ok) {
        const vel = parseFloat(calcVelocity(t).toFixed(1));
        if (!diag.bestRejected || likes > diag.bestRejected.likes) {
          diag.bestRejected = {
            likes,
            velocity: vel,
            reason: `abaixo do ${pass.label} (mín: ${pass.minLikes} likes ou ${pass.minVelocity}/h)`,
          };
        }
      }
      return ok;
    });

    console.log(`[copilot] ${pass.label}: ${passing.length} tweets passaram`);

    if (passing.length > 0) {
      candidates = passing;
      diag.passUsed = pass.label;
      break;
    }
  }

  if (candidates.length === 0) {
    console.log('[copilot] Nenhum tweet passou nenhum passe da cascata.');
    if (telegram && OWNER_CHAT_ID) {
      let diagMsg = `📊 ${diag.totalTweets} tweets analisados. Nenhum passou o piso de engajamento (80 likes ou 20/h).`;
      if (diag.bestRejected) {
        diagMsg += ` Melhor rejeitado: ${diag.bestRejected.likes} likes, ${diag.bestRejected.velocity} likes/h (${diag.bestRejected.reason}).`;
      }
      diagMsg += ` Redes usadas: ${diag.netsUsed.join(', ')}.`;
      if (diag.apiErrors.length > 0) {
        diagMsg += `\n⚠️ Erro de API: ${diag.apiErrors[0]}`;
      }
      await telegram.sendMessage(OWNER_CHAT_ID, diagMsg).catch(() => {});
    }
    return { suggestionsSent: 0 };
  }

  // Remover já sugeridos
  const unseen = [];
  for (const tweet of candidates) {
    if (!(await isTweetSuggested(tweet.id))) unseen.push(tweet);
  }

  if (unseen.length === 0) {
    console.log('[copilot] Todos os candidatos já foram sugeridos anteriormente.');
    if (telegram && OWNER_CHAT_ID) {
      await telegram.sendMessage(
        OWNER_CHAT_ID,
        `📊 ${diag.totalTweets} tweets analisados. Candidatos com engajamento suficiente (${diag.passUsed}) mas todos já foram sugeridos anteriormente.`
      ).catch(() => {});
    }
    return { suggestionsSent: 0 };
  }

  // Filtro de adaptabilidade por IA — nota mínima 6
  console.log(`[copilot] Pontuando ${unseen.length} candidatos por adaptabilidade...`);
  const scored = [];
  for (const tweet of unseen) {
    let score = 6; // fallback otimista em caso de falha da IA
    try {
      score = await scoreAdaptability(tweet.text);
    } catch (err) {
      console.error(`[copilot] Erro ao pontuar tweet ${tweet.id}:`, err.message);
    }
    const vel   = calcVelocity(tweet).toFixed(1);
    const likes = tweet.public_metrics?.like_count ?? 0;
    console.log(`[copilot] Tweet ${tweet.id} — adaptabilidade: ${score} · ${likes} likes · ${vel} likes/h`);

    if (score >= 6) {
      scored.push({ tweet, score });
    } else {
      if (!diag.bestRejected || likes > (diag.bestRejected?.likes ?? 0)) {
        diag.bestRejected = {
          likes,
          velocity: parseFloat(vel),
          reason: `nota de adaptabilidade ${score} (mín. 6)`,
        };
      }
    }
  }

  if (scored.length === 0) {
    console.log('[copilot] Nenhum tweet passou o filtro de adaptabilidade.');
    if (telegram && OWNER_CHAT_ID) {
      let diagMsg = `📊 ${diag.totalTweets} tweets analisados. Engajamento ok (${diag.passUsed}) mas nenhum adaptável à ponte (nota < 6).`;
      if (diag.bestRejected) {
        diagMsg += ` Melhor rejeitado: ${diag.bestRejected.likes} likes, ${diag.bestRejected.velocity} likes/h (${diag.bestRejected.reason}).`;
      }
      diagMsg += ` Redes usadas: ${diag.netsUsed.join(', ')}.`;
      await telegram.sendMessage(OWNER_CHAT_ID, diagMsg).catch(() => {});
    }
    return { suggestionsSent: 0 };
  }

  // Ordenar por score + velocidade combinados, pegar os 3 melhores
  scored.sort((a, b) => {
    const velA = calcVelocity(a.tweet);
    const velB = calcVelocity(b.tweet);
    return (b.score * 100 + velB) - (a.score * 100 + velA);
  });
  const top3 = scored.slice(0, 3);

  console.log(`[copilot] ${top3.length} tweet(s) aprovado(s) para geração de resposta`);

  let suggestionsSent = 0;

  for (const { tweet, score } of top3) {
    try {
      // Gerar resposta com lógica de SKIP — descarta e segue para o próximo se SKIP
      const replyText = await generateReply(tweet.text);

      if (!replyText || replyText.toUpperCase() === 'SKIP') {
        console.log(`[copilot] Tweet ${tweet.id} — resposta SKIP, descartado.`);
        await saveSuggestedTweet(tweet.id, 'SKIP');
        continue;
      }

      const author         = allUsersMap[tweet.author_id];
      const authorUsername = author?.username || 'i/web';
      const tweetUrl       = `https://x.com/${authorUsername}/status/${tweet.id}`;
      const quoteText      = await generateQuote(tweet.text);
      const intentUrl      = buildIntentUrl(tweet.id, replyText);
      const quoteIntentUrl = buildQuoteIntentUrl(tweet.id, authorUsername, quoteText);

      await saveSuggestedTweet(tweet.id, replyText);

      const copilotId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const message = await telegram.sendMessage(
        OWNER_CHAT_ID,
        buildSuggestionMessage(tweet.text, tweetUrl, tweet.public_metrics, replyText),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: copilotKeyboard(copilotId, intentUrl, quoteIntentUrl),
        }
      );

      copilotPendingApprovals.set(copilotId, {
        tweetId:       tweet.id,
        tweetText:     tweet.text,
        tweetUrl,
        authorUsername,
        metrics:       tweet.public_metrics,
        suggestedReply: replyText,
        quoteText,
        quoteIntentUrl,
        messageId:     message.message_id,
      });

      suggestionsSent++;
      console.log(`[copilot] Sugestão enviada — tweet ${tweet.id} (adaptabilidade: ${score})`);
    } catch (err) {
      console.error(`[copilot] Erro ao processar tweet ${tweet.id}:`, err.message);
    }
  }

  // ─── Busca extra por trends ativos ──────────────────────────────────────────

  let activeTrends = [];
  try {
    activeTrends = await getActiveTrends();
  } catch (err) {
    console.error('[copilot] Erro ao carregar trends ativos:', err.message);
  }

  for (const trendRow of activeTrends) {
    let trendResult;
    try {
      trendResult = await fetchTrendTweets(trendRow.trend);
    } catch (err) {
      console.error(`[copilot] Erro ao buscar tweets do trend "${trendRow.trend}":`, err.message);
      continue;
    }

    if (trendResult.selected.length === 0) {
      console.log(`[copilot] Trend "${trendRow.trend}": nenhum tweet elegível.`);
      continue;
    }

    for (const tweet of trendResult.selected) {
      try {
        const replyText = await generateTrendReply(tweet.text, trendRow.trend, trendRow.angle);

        if (!replyText || replyText.toUpperCase() === 'SKIP') {
          console.log(`[copilot] Trend tweet ${tweet.id} — SKIP, descartado.`);
          await saveSuggestedTweet(tweet.id, 'SKIP');
          continue;
        }

        const author         = trendResult.usersMap[tweet.author_id];
        const authorUsername = author?.username || 'i/web';
        const tweetUrl       = `https://x.com/${authorUsername}/status/${tweet.id}`;
        const quoteText      = await generateQuote(tweet.text);
        const intentUrl      = buildIntentUrl(tweet.id, replyText);
        const quoteIntentUrl = buildQuoteIntentUrl(tweet.id, authorUsername, quoteText);

        await saveSuggestedTweet(tweet.id, replyText);

        const copilotId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        const message = await telegram.sendMessage(
          OWNER_CHAT_ID,
          buildSuggestionMessage(tweet.text, tweetUrl, tweet.public_metrics, replyText, false, trendRow.trend),
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
          suggestedReply: replyText,
          quoteText,
          quoteIntentUrl,
          trendName:      trendRow.trend,
          messageId:      message.message_id,
        });

        suggestionsSent++;
        console.log(`[copilot] Sugestão de trend "${trendRow.trend}" enviada — tweet ${tweet.id}`);
      } catch (err) {
        console.error(`[copilot] Erro ao processar tweet de trend ${tweet.id}:`, err.message);
      }
    }
  }

  return { suggestionsSent };
}

async function skipTweet(tweetId) {
  await markTweetSkipped(tweetId);
}

// ─── Iniciar crons ────────────────────────────────────────────────────────────

function startCopilot(telegram) {
  const slots = [
    { h: 9,  label: '9h',  refreshTrends: true  },
    { h: 12, label: '12h', refreshTrends: false },
    { h: 15, label: '15h', refreshTrends: true  },
    { h: 18, label: '18h', refreshTrends: false },
    { h: 21, label: '21h', refreshTrends: false },
  ];

  slots.forEach(({ h, label, refreshTrends }) => {
    cron.schedule(
      `0 ${h} * * *`,
      async () => {
        try {
          if (refreshTrends) await fetchAndStoreTrends();
          await runCopilotSearch(telegram);
        } catch (e) {
          console.error(`[copilot] Erro cron ${label}:`, e.message);
        }
      },
      { timezone: 'America/Sao_Paulo' }
    );
  });

  console.log('[copilot] Agendado: 9h · 12h · 15h · 18h · 21h (America/Sao_Paulo)');
  console.log('[copilot] Refresh de trends: 9h · 15h');
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
