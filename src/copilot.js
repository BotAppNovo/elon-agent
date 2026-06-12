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

// copilotId -> { tweetId, tweetText, tweetUrl, authorUsername, metrics, suggestedReply, quoteText, quoteIntentUrl, messageId }
const copilotPendingApprovals = new Map();

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const X_USERNAME = process.env.X_USERNAME || null;

// ─── 12 grupos de palavras-chave (rotação persistida no banco) ────────────────
// Cada grupo vira: (keywords) lang:pt -is:retweet -is:reply
// Todas as queries ficam bem abaixo do limite de 512 chars da API do X.

const KEYWORD_GROUPS = [
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

// Tentativas em cascata — máx. 3 por execução
// minVelocity: likes/hora mínimo para aceitar mesmo sem minLikes (null = sem fallback por velocidade)
const CASCADE_ATTEMPTS = [
  { hoursBack: 12, minLikes: 100, minVelocity: 30   }, // tentativa 1
  { hoursBack: 24, minLikes: 50,  minVelocity: 15   }, // tentativa 2
  { hoursBack: 24, minLikes: 20,  minVelocity: null }, // tentativa 3 — abaixo de 20 likes, nunca sugerir
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
3. Varie entre: concordar com exagero cômico, contar micro-história pessoal em 1 frase, fazer pergunta que cutuca, dar opinião contrária leve
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

// ─── Velocidade de engajamento (likes/hora) ───────────────────────────────────

function calcVelocity(tweet) {
  const hoursElapsed = Math.max(
    (Date.now() - new Date(tweet.created_at).getTime()) / (1000 * 60 * 60),
    0.1 // evita divisão por zero para tweets segundos após publicação
  );
  return tweet.public_metrics.like_count / hoursElapsed;
}

// ─── Busca individual (uma tentativa da cascata) ──────────────────────────────

async function fetchAndFilter(keywords, hoursBack, minLikes, minVelocity) {
  const query = `(${keywords}) lang:pt -is:retweet -is:reply`;
  console.log(`[copilot] Buscando (${hoursBack}h, >=${minLikes} likes${minVelocity !== null ? ` OU >=${minVelocity} likes/h` : ''}): ${query}`);

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

  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  const filtered = tweets.filter((t) => {
    if (new Date(t.created_at) < cutoff) return false;
    const likes    = t.public_metrics.like_count;
    const velocity = calcVelocity(t);
    return likes >= minLikes || (minVelocity !== null && velocity >= minVelocity);
  });

  // Ordenar por velocidade de engajamento (tendência em andamento)
  filtered.sort((a, b) => calcVelocity(b) - calcVelocity(a));

  // Até 3 melhores, excluindo já sugeridos
  const selected = [];
  for (const tweet of filtered) {
    if (selected.length >= 3) break;
    if (!(await isTweetSuggested(tweet.id))) selected.push(tweet);
  }

  console.log(
    `[copilot] ${tweets.length} encontrados -> ${filtered.length} elegíveis -> ${selected.length} candidatos`
  );

  return { selected, usersMap };
}

// ─── Busca principal em cascata ───────────────────────────────────────────────

async function runCopilotSearch(telegram) {
  const enabled = (await getSetting('copilot_enabled')) !== 'false';
  if (!enabled) {
    console.log('[copilot] Desativado — busca ignorada.');
    return;
  }

  // Ler índice persistido; avança a cada tentativa para nunca repetir grupos
  const rawIdx = await getSetting('copilot_keyword_index');
  let idx = rawIdx !== null ? parseInt(rawIdx, 10) : 0;
  if (isNaN(idx) || idx < 0) idx = 0;

  let approvedTweets = null; // { tweets, usersMap }

  for (let attempt = 0; attempt < CASCADE_ATTEMPTS.length; attempt++) {
    const { hoursBack, minLikes, minVelocity } = CASCADE_ATTEMPTS[attempt];
    const keywords = KEYWORD_GROUPS[idx % KEYWORD_GROUPS.length];

    // Avança e persiste o índice ANTES de tentar (garante progresso mesmo em erro)
    idx = (idx + 1) % KEYWORD_GROUPS.length;
    await saveSetting('copilot_keyword_index', String(idx));

    let selected, usersMap;
    try {
      ({ selected, usersMap } = await fetchAndFilter(keywords, hoursBack, minLikes, minVelocity));
    } catch (err) {
      console.error(`[copilot] Erro na tentativa ${attempt + 1}:`, err.message);
      continue;
    }

    if (selected.length === 0) {
      console.log(`[copilot] Tentativa ${attempt + 1}: nenhum candidato após filtros de engajamento.`);
      continue;
    }

    // Filtro de relevância por nota — mínimo 6 em todas as tentativas
    const relevant = [];
    for (const tweet of selected) {
      let score = 6; // fallback otimista em caso de falha da IA
      try {
        score = await scoreRelevance(tweet.text);
      } catch (err) {
        console.error(`[copilot] Erro ao pontuar tweet ${tweet.id}:`, err.message);
      }
      const vel = calcVelocity(tweet).toFixed(1);
      console.log(`[copilot] Tweet ${tweet.id} — nota ${score} · ${tweet.public_metrics.like_count} likes · ${vel} likes/h`);

      if (score >= 6) relevant.push(tweet);
    }

    if (relevant.length > 0) {
      approvedTweets = { tweets: relevant, usersMap };
      console.log(
        `[copilot] Tentativa ${attempt + 1}: ${relevant.length} tweet(s) aprovado(s) — cascata encerrada.`
      );
      break;
    }

    console.log(`[copilot] Tentativa ${attempt + 1}: nenhum tweet passou o filtro de relevancia.`);
  }

  if (!approvedTweets) {
    console.log('[copilot] Cascata encerrada sem candidatos fortes.');
    if (telegram && OWNER_CHAT_ID) {
      await telegram
        .sendMessage(
          OWNER_CHAT_ID,
          '🔍 Busca concluída sem candidatos fortes. Próxima tentativa automática no horário do cron.'
        )
        .catch(() => {});
    }
    return;
  }

  const { tweets, usersMap } = approvedTweets;

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

      console.log(`[copilot] Sugestão enviada — tweet ${tweet.id}`);
    } catch (err) {
      console.error(`[copilot] Erro ao processar tweet ${tweet.id}:`, err.message);
    }
  }
}

async function skipTweet(tweetId) {
  await markTweetSkipped(tweetId);
}

// ─── Iniciar crons ────────────────────────────────────────────────────────────

function startCopilot(telegram) {
  const slots = [
    { h: 9,  label: '9h'  },
    { h: 12, label: '12h' },
    { h: 15, label: '15h' },
    { h: 18, label: '18h' },
    { h: 21, label: '21h' },
  ];

  slots.forEach(({ h, label }) => {
    cron.schedule(
      `0 ${h} * * *`,
      () => runCopilotSearch(telegram).catch((e) => console.error(`[copilot] Erro cron ${label}:`, e.message)),
      { timezone: 'America/Sao_Paulo' }
    );
  });

  console.log('[copilot] Agendado: 9h · 12h · 15h · 18h · 21h (America/Sao_Paulo)');
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
