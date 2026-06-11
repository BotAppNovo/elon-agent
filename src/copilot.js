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
const CASCADE_ATTEMPTS = [
  { hoursBack: 12, minLikes: 50, minRts: 10, flexible: false }, // tentativa 1
  { hoursBack: 24, minLikes: 20, minRts: 5,  flexible: false }, // tentativa 2
  { hoursBack: 24, minLikes: 5,  minRts: 0,  flexible: true  }, // tentativa 3 (modo flexível)
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

const QUOTE_SYSTEM_PROMPT = `Você gera textos curtos para quote tweet em português sobre produtividade, esquecimento, carga mental e rotina.

REGRAS ABSOLUTAS:
1. Você comenta ou acrescenta perspectiva sobre o assunto do tweet — NÃO responde ao autor, NÃO é um diálogo
2. Português brasileiro natural e informal
3. NUNCA técnico, corporativo ou comercial
4. Estilos: (a) opinião ou dado que amplifica o tema, (b) pergunta retórica sobre o assunto geral
5. Máximo 200 caracteres — conte antes de responder
6. Zero hashtags, zero links
7. No máximo 1 emoji — e só se fizer sentido real
8. NUNCA mencionar o Myndit, nunca fazer propaganda, nunca citar produto algum
9. O texto deve fazer sentido isolado, sem referência ao autor original

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

// ─── Busca individual (uma tentativa da cascata) ──────────────────────────────

async function fetchAndFilter(keywords, hoursBack, minLikes, minRts) {
  const query = `(${keywords}) lang:pt -is:retweet -is:reply`;
  console.log(`[copilot] Buscando (${hoursBack}h, >=/${minLikes} likes ou >=${minRts} RTs): ${query}`);

  const response = await rwClient.v2.search(query, {
    max_results: 20,
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
    const m = t.public_metrics;
    return m.like_count >= minLikes || (m.retweet_count + (m.quote_count || 0)) >= minRts;
  });

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
    `[copilot] ${tweets.length} encontrados -> ${filtered.length} elegiveis -> ${selected.length} candidatos`
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
    const { hoursBack, minLikes, minRts, flexible } = CASCADE_ATTEMPTS[attempt];
    const keywords = KEYWORD_GROUPS[idx % KEYWORD_GROUPS.length];

    // Avança e persiste o índice ANTES de tentar (garante progresso mesmo em erro)
    idx = (idx + 1) % KEYWORD_GROUPS.length;
    await saveSetting('copilot_keyword_index', String(idx));

    let selected, usersMap;
    try {
      ({ selected, usersMap } = await fetchAndFilter(keywords, hoursBack, minLikes, minRts));
    } catch (err) {
      console.error(`[copilot] Erro na tentativa ${attempt + 1}:`, err.message);
      continue;
    }

    if (selected.length === 0) {
      console.log(`[copilot] Tentativa ${attempt + 1}: nenhum candidato apos filtros de engajamento.`);
      continue;
    }

    // Filtro de relevância por nota
    const relevant = [];
    for (const tweet of selected) {
      let score = 6; // fallback otimista em caso de falha da IA
      try {
        score = await scoreRelevance(tweet.text);
      } catch (err) {
        console.error(`[copilot] Erro ao pontuar tweet ${tweet.id}:`, err.message);
      }
      const modeLabel = flexible ? ' (modo flexivel)' : '';
      console.log(`[copilot] Tweet ${tweet.id} — nota ${score}${modeLabel}`);

      if (score >= 6) {
        relevant.push(tweet);
      } else if (flexible && score >= 4) {
        relevant.push(tweet); // aceita nota 4-5 apenas na tentativa 3
      }
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
  buildIntentUrl,
  buildQuoteIntentUrl,
  skipTweet,
};
