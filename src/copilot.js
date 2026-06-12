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

// ─── Grupos de palavras-chave (rotação persistida no banco) ──────────────────
// NICHE_GROUPS (A–L): frases exatas entre aspas — alta precisão, menor volume.
// BROAD_GROUPS (M–Q): palavras sem aspas — maior alcance, encontra tweets virais.
// A cascata usa obrigatoriamente: tentativa 1 → AMPLO, tentativas 2–3 → NICHO.

const NICHE_GROUPS = [
  // A — Esquecimento
  '"esqueci" OR "quase esqueci" OR "ia esquecer" OR "esqueci de novo" OR "vivo esquecendo" OR "esqueço tudo" OR "tinha esquecido" OR "esqueci completamente"',
  // B — Memória
  '"memória de peixe" OR "memória péssima" OR "minha memória ta" OR "não lembro de nada" OR "lembrei agora" OR "só lembrei depois" OR "lembrei tarde" OR "memória horrível"',
  // C — Sobrecarga
  '"cabeça cheia" OR "mente cheia" OR "mil coisas" OR "não dou conta" OR "sobrecarregada" OR "sobrecarregado" OR "pensando em mil coisas" OR "muita coisa na cabeça"',
  // D — Procrastinação
  '"procrastinando" OR "procrastinação" OR "deixei pra depois" OR "empurrando com a barriga" OR "enrolando pra fazer" OR "preguiça de fazer" OR "depois eu faço" OR "adiando isso"',
  // E — Tarefas
  '"lista de tarefas" OR "to do list" OR "pendências" OR "tarefas acumuladas" OR "checklist" OR "tanta coisa pendente" OR "tarefas atrasadas" OR "lista enorme"',
  // F — Rotina
  '"rotina corrida" OR "dia corrido" OR "semana lotada" OR "agenda lotada" OR "correria" OR "dia cheio" OR "não paro um minuto" OR "sem tempo pra nada"',
  // G — Mente acelerada
  '"mente não desliga" OR "cabeça não para" OR "pensamento acelerado" OR "não consigo relaxar" OR "mente a mil" OR "cérebro não desliga" OR "cabeça a mil" OR "não desligo"',
  // H — Compromissos perdidos
  '"esqueci a reunião" OR "perdi o prazo" OR "esqueci o boleto" OR "esqueci a consulta" OR "perdi a consulta" OR "esqueci de pagar" OR "esqueci de responder" OR "esqueci o aniversário"',
  // I — Gambiarras de memória
  '"alarme no celular" OR "lembrete no celular" OR "post-it" OR "bloco de notas" OR "mandei mensagem pra mim" OR "anotar pra não esquecer" OR "vários alarmes" OR "anotei e esqueci"',
  // J — Noite / insônia
  '"acordei lembrando" OR "não consigo dormir pensando" OR "deitei e lembrei" OR "madrugada pensando" OR "lembrei na hora de dormir" OR "insônia pensando" OR "acordei às 3" OR "pensando antes de dormir"',
  // K — Desabafo de produtividade
  '"produtividade zero" OR "dia improdutivo" OR "não rendi nada" OR "não fiz nada hoje" OR "travada" OR "travado no trabalho" OR "foco zero" OR "sem foco nenhum"',
  // L — Organização
  '"me organizar" OR "preciso me organizar" OR "desorganizada" OR "desorganizado" OR "tentando me organizar" OR "organizar minha vida" OR "vida uma bagunça" OR "tudo bagunçado"',
];

const BROAD_GROUPS = [
  // M — Esquecimento amplo (palavras comuns sem aspas — mais volume)
  'esqueci esqueço esquecimento memória lembrei OR "ia esquecer" OR "quase esqueci"',
  // N — Sobrecarga mental ampla
  'sobrecarregado OR sobrecarregada OR "cabeça cheia" OR "mente cheia" OR esgotado OR esgotada OR "tô exausto" OR "tô exausta"',
  // O — Procrastinação ampla
  'procrastinando OR adiando OR "deixei pra depois" OR "vou fazer depois" OR enrolando OR "sem motivação"',
  // P — Rotina e correria amplas
  'correria OR "dia corrido" OR "semana corrida" OR "agenda cheia" OR "sem tempo" OR ocupado OR ocupada OR corrido',
  // Q — Foco e produtividade amplas
  '"sem foco" OR "foco zero" OR improdutivo OR improdutiva OR distraído OR distraída OR "não consigo me concentrar"',
];

// Tentativas em cascata — máx. 3 por execução
// groupType: 'broad' usa BROAD_GROUPS (M–Q); 'niche' usa NICHE_GROUPS (A–L)
// minVelocity: likes/hora mínimo para aceitar mesmo sem minLikes (null = sem fallback)
const CASCADE_ATTEMPTS = [
  { groupType: 'broad', hoursBack: 12, minLikes: 100, minVelocity: 30   }, // tentativa 1 — amplo
  { groupType: 'niche', hoursBack: 24, minLikes: 50,  minVelocity: 15   }, // tentativa 2 — nicho
  { groupType: 'niche', hoursBack: 24, minLikes: 20,  minVelocity: null }, // tentativa 3 — nicho fallback
];

// ─── Filtro de relevância por nota (0–10) ────────────────────────────────────

async function scoreRelevance(tweetText) {
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content:
          `Dê uma nota de 0 a 10 para o quanto este tweet expressa uma experiência PESSOAL com: ` +
          `esquecimento, sobrecarga mental, procrastinação, rotina corrida ou pendências acumuladas. ` +
          `Tweets sobre política, economia, notícias ou esportes = nota 0. ` +
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

// ─── Geração da resposta ─────────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `Você é a voz do perfil do Myndit no X. Você responde tweets virais como uma PESSOA real, nunca como uma marca.

REGRAS DE OURO:
1. Escreva como brasileiro fala no X: informal, direto, com personalidade
2. Reaja ao conteúdo específico do tweet — nunca resposta genérica que serviria em qualquer tweet
3. Varie entre: concordar com exagero cômico, contar micro-história pessoal em 1 frase, fazer pergunta que cutuca, dar opinião contrária leve, humor e zueira leve quando o tweet pedir esse tom — combinar a energia do tweet original
4. Máximo 180 caracteres. Respostas curtas performam melhor
5. Zero hashtags, zero links, no máximo 1 emoji (de preferência nenhum)
6. NUNCA mencione o Myndit, app, produto ou solução. Você é só uma pessoa na conversa

PROIBIDO (linguagem robótica que mata o engajamento):
- "Que interessante", "Concordo plenamente", "Isso é muito comum"
- "Já parou para pensar", "A verdade é que", "No final do dia"
- Qualquer frase que pareça de assistente virtual ou consultoria
- Reformular o que o tweet já disse com outras palavras

EXEMPLOS DE TOM CERTO:
- Tweet: "esqueci de pagar o boleto DE NOVO" → "o boleto vencido é só o sintoma, o problema é a gente confiar na própria cabeça pela 47ª vez"
- Tweet: "minha cabeça não desliga nunca" → "e o pior horário é 23h47, quando ela resolve listar tudo que você não fez desde 2019"
- Tweet: "preciso me organizar urgente" → "todo mundo fala isso na segunda. quarta-feira a cabeça já virou aba de navegador de novo"

Retorne APENAS o texto da resposta, sem aspas, sem prefixo.`;

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
    0.1 // evita divisão por zero para tweets segundos após publicação
  );
  return (tweet.public_metrics?.like_count ?? 0) / hoursElapsed;
}

// ─── Busca individual (uma tentativa da cascata) ──────────────────────────────

// Retorna { selected, usersMap, totalReturned, query, error }
// Nunca lança — captura erros e os retorna para diagnóstico.
async function fetchAndFilter(searchNum, groupLabel, keywords, hoursBack, minLikes, minVelocity) {
  const query = `(${keywords}) lang:pt -is:retweet -is:reply`;
  const searchParams = {
    max_results: 25,
    sort_order: 'relevancy',
    'tweet.fields': 'public_metrics,created_at,author_id',
    expansions: 'author_id',
    'user.fields': 'username',
  };

  console.log(`[copilot] Busca ${searchNum}: grupo ${groupLabel}, query: "${query}"`);
  console.log(`[copilot] Busca ${searchNum}: parâmetros: ${JSON.stringify(searchParams)}`);

  let response;
  try {
    response = await rwClient.v2.search(query, searchParams);
  } catch (err) {
    const detail = err.data ? JSON.stringify(err.data) : err.message;
    console.error(`[copilot] Busca ${searchNum} erro de API: ${detail}`);
    return { selected: [], usersMap: {}, totalReturned: 0, query, error: detail };
  }

  const tweets = response.data?.data || [];
  const usersMap = {};
  (response.data?.includes?.users || []).forEach((u) => { usersMap[u.id] = u; });

  console.log(`[copilot] Busca ${searchNum} retornou ${tweets.length} tweets`);

  // Log top 5 por likes ANTES do filtro — diagnostica se public_metrics estão chegando
  const top5 = [...tweets]
    .sort((a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0))
    .slice(0, 5);
  if (top5.length > 0) {
    const lines = top5.map((t) => {
      const likes = t.public_metrics?.like_count ?? 'N/A';
      const rts   = (t.public_metrics?.retweet_count ?? 0) + (t.public_metrics?.quote_count ?? 0);
      const ageMs = t.created_at ? Date.now() - new Date(t.created_at).getTime() : null;
      const age   = ageMs !== null ? (ageMs / (1000 * 60 * 60)).toFixed(1) : 'N/A';
      const vel   = ageMs !== null ? ((t.public_metrics?.like_count ?? 0) / Math.max(ageMs / (1000 * 60 * 60), 0.1)).toFixed(1) : 'N/A';
      const text  = (t.text ?? '').substring(0, 50).replace(/\n/g, ' ');
      return `  "${text}..." (likes:${likes}, RTs:${rts}, vel:${vel}/h, idade:${age}h)`;
    });
    console.log(`[copilot] Top candidatos pré-filtro (busca ${searchNum}):\n${lines.join('\n')}`);
  }

  // Debug de velocidade: log do cálculo do primeiro tweet com created_at
  const sample = tweets.find((t) => t.created_at);
  if (sample) {
    const ageH  = ((Date.now() - new Date(sample.created_at).getTime()) / (1000 * 60 * 60)).toFixed(2);
    const likes = sample.public_metrics?.like_count ?? 'N/A';
    const vel   = likes !== 'N/A' ? (likes / Math.max(parseFloat(ageH), 0.1)).toFixed(2) : 'N/A';
    console.log(`[copilot] Exemplo velocidade: tweet ${sample.id} | created_at=${sample.created_at} | likes=${likes} | idade=${ageH}h | vel=${vel}/h`);
  } else if (tweets.length > 0) {
    console.warn(`[copilot] Busca ${searchNum}: NENHUM tweet tem created_at — public_metrics provavelmente ausentes`);
  }

  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  const filtered = tweets.filter((t) => {
    if (!t.created_at || new Date(t.created_at) < cutoff) return false;
    const likes    = t.public_metrics?.like_count ?? 0;
    const velocity = calcVelocity(t);
    return likes >= minLikes || (minVelocity !== null && velocity >= minVelocity);
  });

  console.log(`[copilot] Após filtro de engajamento (passe ${searchNum}): ${filtered.length} tweets`);

  // Ordenar por velocidade de engajamento (tendência em andamento)
  filtered.sort((a, b) => calcVelocity(b) - calcVelocity(a));

  // Até 3 melhores, excluindo já sugeridos
  const selected = [];
  for (const tweet of filtered) {
    if (selected.length >= 3) break;
    if (!(await isTweetSuggested(tweet.id))) selected.push(tweet);
  }

  return { selected, usersMap, totalReturned: tweets.length, query, error: null };
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

  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);

  const filtered = tweets.filter((t) => {
    if (!t.created_at || new Date(t.created_at) < cutoff) return false;
    const likes    = t.public_metrics?.like_count ?? 0;
    const velocity = calcVelocity(t);
    return likes >= 50 || velocity >= 15;
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

// ─── Busca principal em cascata ───────────────────────────────────────────────

// Retorna { suggestionsSent } para que o chamador saiba se enviou sugestões.
async function runCopilotSearch(telegram) {
  const enabled = (await getSetting('copilot_enabled')) !== 'false';
  if (!enabled) {
    console.log('[copilot] Desativado — busca ignorada.');
    return { suggestionsSent: 0 };
  }

  // Índices persistidos separados para cada pool
  const rawNicheIdx = await getSetting('copilot_keyword_index');
  let nicheIdx = rawNicheIdx !== null ? parseInt(rawNicheIdx, 10) : 0;
  if (isNaN(nicheIdx) || nicheIdx < 0) nicheIdx = 0;

  const rawBroadIdx = await getSetting('copilot_broad_index');
  let broadIdx = rawBroadIdx !== null ? parseInt(rawBroadIdx, 10) : 0;
  if (isNaN(broadIdx) || broadIdx < 0) broadIdx = 0;

  // Diagnóstico acumulado durante toda a execução
  const diag = {
    totalTweets:   0,        // total retornado pelas APIs
    searchCount:   0,        // quantas buscas foram feitas
    groupsUsed:    [],       // letras dos grupos usados
    apiErrors:     [],       // erros de API
    bestRejected:  null,     // { likes, velocity, reason, score }
  };

  let approvedTweets = null; // { tweets, usersMap }

  for (let attempt = 0; attempt < CASCADE_ATTEMPTS.length; attempt++) {
    const { groupType, hoursBack, minLikes, minVelocity } = CASCADE_ATTEMPTS[attempt];

    let keywords, groupLabel;
    if (groupType === 'broad') {
      const gi   = broadIdx % BROAD_GROUPS.length;
      groupLabel = String.fromCharCode(77 + gi); // M–Q
      keywords   = BROAD_GROUPS[gi];
      broadIdx   = (broadIdx + 1) % BROAD_GROUPS.length;
      await saveSetting('copilot_broad_index', String(broadIdx));
    } else {
      const gi   = nicheIdx % NICHE_GROUPS.length;
      groupLabel = String.fromCharCode(65 + gi); // A–L
      keywords   = NICHE_GROUPS[gi];
      nicheIdx   = (nicheIdx + 1) % NICHE_GROUPS.length;
      await saveSetting('copilot_keyword_index', String(nicheIdx));
    }

    diag.searchCount++;
    diag.groupsUsed.push(groupLabel);

    const { selected, usersMap, totalReturned, error } = await fetchAndFilter(
      attempt + 1, groupLabel, keywords, hoursBack, minLikes, minVelocity
    );

    diag.totalTweets += totalReturned;
    if (error) diag.apiErrors.push(error);

    if (selected.length === 0) {
      // Rastrear o melhor candidato rejeitado pelo filtro de engajamento
      // (já não temos acesso aos tweets brutos aqui — registrado no nível do filtro)
      console.log(`[copilot] Tentativa ${attempt + 1}: nenhum candidato após filtros de engajamento.`);
      continue;
    }

    // Filtro de relevância por nota — mínimo 6 em todas as tentativas
    const scores = [];
    const relevant = [];
    for (const tweet of selected) {
      let score = 6; // fallback otimista em caso de falha da IA
      try {
        score = await scoreRelevance(tweet.text);
      } catch (err) {
        console.error(`[copilot] Erro ao pontuar tweet ${tweet.id}:`, err.message);
      }
      const vel = calcVelocity(tweet).toFixed(1);
      scores.push(score);
      console.log(`[copilot] Tweet ${tweet.id} — nota ${score} · ${tweet.public_metrics.like_count} likes · ${vel} likes/h`);

      if (score >= 6) {
        relevant.push(tweet);
      } else {
        // Atualiza melhor rejeitado por relevância
        const likes = tweet.public_metrics.like_count;
        const velocity = parseFloat(calcVelocity(tweet).toFixed(1));
        if (
          !diag.bestRejected ||
          likes > diag.bestRejected.likes
        ) {
          diag.bestRejected = { likes, velocity, reason: `nota de relevância ${score}`, score };
        }
      }
    }

    console.log(`[copilot] Após filtro de relevância IA: ${relevant.length} tweets (notas: ${scores.join(', ')})`);

    if (relevant.length > 0) {
      approvedTweets = { tweets: relevant, usersMap };
      console.log(
        `[copilot] Tentativa ${attempt + 1}: ${relevant.length} tweet(s) aprovado(s) — cascata encerrada.`
      );
      break;
    }

    console.log(`[copilot] Tentativa ${attempt + 1}: nenhum tweet passou o filtro de relevância.`);
  }

  if (!approvedTweets) {
    console.log('[copilot] Cascata encerrada sem candidatos fortes.');
    if (telegram && OWNER_CHAT_ID) {
      let diagMsg = `📊 ${diag.totalTweets} tweets analisados em ${diag.searchCount} busca(s).`;
      if (diag.bestRejected) {
        diagMsg += ` Melhor candidato rejeitado: ${diag.bestRejected.likes} likes, ${diag.bestRejected.velocity} likes/h (motivo: ${diag.bestRejected.reason}).`;
      } else {
        diagMsg += ` Nenhum tweet passou o filtro de engajamento.`;
      }
      diagMsg += ` Grupos usados: ${diag.groupsUsed.join(', ')}.`;
      if (diag.apiErrors.length > 0) {
        diagMsg += `\n⚠️ Erro na busca: ${diag.apiErrors[0]}`;
      }
      await telegram.sendMessage(OWNER_CHAT_ID, diagMsg).catch(() => {});
    }
    return { suggestionsSent: 0 };
  }

  const { tweets, usersMap } = approvedTweets;
  let suggestionsSent = 0;

  console.log(`[copilot] Enviando ${tweets.length} sugestão(ões)`);

  for (const tweet of tweets) {
    try {
      const author = usersMap[tweet.author_id];
      const authorUsername = author?.username || 'i/web';
      const tweetUrl = `https://x.com/${authorUsername}/status/${tweet.id}`;
      const suggestedReply = await generateReply(tweet.text);
      const quoteText = await generateQuote(tweet.text);
      const intentUrl = buildIntentUrl(tweet.id, suggestedReply);
      const quoteIntentUrl = buildQuoteIntentUrl(tweet.id, authorUsername, quoteText);

      await saveSuggestedTweet(tweet.id, suggestedReply);

      const copilotId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

      const message = await telegram.sendMessage(
        OWNER_CHAT_ID,
        buildSuggestionMessage(tweet.text, tweetUrl, tweet.public_metrics, suggestedReply),
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: copilotKeyboard(copilotId, intentUrl, quoteIntentUrl),
        }
      );

      copilotPendingApprovals.set(copilotId, {
        tweetId: tweet.id,
        tweetText: tweet.text,
        tweetUrl,
        authorUsername,
        metrics: tweet.public_metrics,
        suggestedReply,
        quoteText,
        quoteIntentUrl,
        messageId: message.message_id,
      });

      suggestionsSent++;
      console.log(`[copilot] Sugestão enviada — tweet ${tweet.id}`);
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

        const author = trendResult.usersMap[tweet.author_id];
        const authorUsername = author?.username || 'i/web';
        const tweetUrl = `https://x.com/${authorUsername}/status/${tweet.id}`;
        const quoteText = await generateQuote(tweet.text);
        const intentUrl = buildIntentUrl(tweet.id, replyText);
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
          tweetId:         tweet.id,
          tweetText:       tweet.text,
          tweetUrl,
          authorUsername,
          metrics:         tweet.public_metrics,
          suggestedReply:  replyText,
          quoteText,
          quoteIntentUrl,
          trendName:       trendRow.trend,
          messageId:       message.message_id,
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
