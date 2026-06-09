'use strict';

const Parser = require('rss-parser');
const { TwitterApi } = require('twitter-api-v2');
const { getActiveContexts, getRssSources, saveSetting, getSetting } = require('./db');

// ─── Fontes padrão ────────────────────────────────────────────────────────────
// Exibidas no /fontes. Não ficam no banco — são constantes.

const DEFAULT_SOURCES = [
  {
    name: 'Hacker News',
    url: 'https://hnrss.org/frontpage',
    desc: 'Tech, startups, produto',
  },
  {
    name: 'Product Hunt',
    url: 'https://www.producthunt.com/feed',
    desc: 'Lançamentos de apps e produtos',
  },
  {
    name: 'Dev.to · Productivity',
    url: 'https://dev.to/feed/tag/productivity',
    desc: 'Artigos sobre produtividade',
  },
  {
    name: 'Dev.to · UX',
    url: 'https://dev.to/feed/tag/ux',
    desc: 'UX, design de produto',
  },
  {
    name: 'Ness Labs',
    url: 'https://nesslabs.com/feed',
    desc: 'Ciência cognitiva, saúde mental, produtividade',
  },
];

// Palavras-chave para calcular relevância dos itens de RSS
const RELEVANCE_KEYWORDS = [
  'productivity', 'produtividade', 'reminder', 'lembrete', 'todo', 'task',
  'cognitive', 'cognitiv', 'mental', 'focus', 'attention', 'anxiety',
  'habit', 'habito', 'memory', 'memoria', 'app', 'mobile', 'workflow',
  'burnout', 'overwhelm', 'brain', 'adhd', 'procrastin', 'distract',
  'notification', 'mindful', 'stress', 'time management', 'organization',
  'note', 'notas', 'checklist', 'reminder', 'alert', 'overload', 'carga',
];

// Query para busca de tweets em português
const X_SEARCH_QUERY =
  '(produtividade OR "carga cognitiva" OR lembretes OR esquecimento OR "to-do" OR procrastinação OR "lista de tarefas") lang:pt -is:retweet -is:reply';

// ─── Instância do parser RSS ──────────────────────────────────────────────────

const rssParser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; elon-agent/1.0; +myndit.app)' },
  customFields: { item: [['description', 'description']] },
});

// ─── Entry point principal ────────────────────────────────────────────────────

/**
 * Agrega pesquisa de todas as fontes.
 * Retorna: { rssItems, xInsights, contexts, fetchedAt }
 */
async function gatherResearch() {
  if (process.env.RESEARCH_ENABLED === 'false') {
    return {
      rssItems: [],
      xInsights: [],
      contexts: await getActiveContexts(8),
      fetchedAt: new Date().toISOString(),
      skipped: true,
    };
  }

  // Busca RSS e X em paralelo — falha individual não bloqueia o restante
  const [rssResult, xResult] = await Promise.allSettled([
    fetchAllRss(),
    fetchXInsights(),
  ]);

  const rssItems = rssResult.status === 'fulfilled'
    ? rssResult.value
    : (console.warn('[research] RSS falhou:', rssResult.reason?.message), []);

  const xInsights = xResult.status === 'fulfilled'
    ? xResult.value
    : (console.warn('[research] X search falhou (pode ser limitação de tier):', xResult.reason?.message), []);

  const fetchedAt = new Date().toISOString();

  // Persiste o timestamp da última pesquisa para o /fontes
  await saveSetting('last_research_at', fetchedAt);
  await saveSetting('last_research_rss_count', String(rssItems.length));
  await saveSetting('last_research_x_count', String(xInsights.length));

  return {
    rssItems,
    xInsights,
    contexts: await getActiveContexts(8),
    fetchedAt,
  };
}

// ─── RSS ──────────────────────────────────────────────────────────────────────

async function fetchAllRss() {
  const userSources = await getRssSources(); // fontes adicionadas pelo usuário via /fontes
  const allSources = [
    ...DEFAULT_SOURCES,
    ...userSources.map((s) => ({ name: s.name, url: s.url, desc: 'Custom' })),
  ];

  const results = await Promise.allSettled(
    allSources.map((src) => withTimeout(fetchOneFeed(src), 7000, src.name))
  );

  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      items.push(...r.value);
    } else {
      console.warn(`[research] Feed "${allSources[i].name}" ignorado: ${r.reason?.message}`);
    }
  });

  // Ordena por relevância (desc) e retorna os top 8
  return items
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 8);
}

async function fetchOneFeed(source) {
  const feed = await rssParser.parseURL(source.url);
  const items = (feed.items || []).slice(0, 6);

  return items
    .map((item) => {
      const raw = [
        item.title || '',
        item.contentSnippet || item.description || item.summary || '',
      ].join(' ').toLowerCase();

      const relevanceScore = RELEVANCE_KEYWORDS.filter((k) => raw.includes(k)).length;

      return {
        source: source.name,
        title: (item.title || '').trim(),
        snippet: (item.contentSnippet || item.description || item.summary || '')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 220),
        url: item.link || '',
        publishedAt: item.pubDate || item.isoDate || '',
        relevanceScore,
      };
    })
    .filter((i) => i.title); // descarta itens sem título
}

// ─── X search ─────────────────────────────────────────────────────────────────

async function fetchXInsights() {
  // Requer pelo menos o plano Basic do X ($100/mês).
  // Falha com 403 no Free tier — retorna [] graciosamente.
  const client = new TwitterApi({
    appKey:      process.env.X_CLIENT_ID,
    appSecret:   process.env.X_CLIENT_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });

  const response = await client.v2.search(X_SEARCH_QUERY, {
    max_results: 15,
    'tweet.fields': 'public_metrics,created_at',
    sort_order: 'relevancy',
  });

  const tweets = response.data?.data || [];

  return tweets
    .filter((t) => {
      const likes = t.public_metrics?.like_count || 0;
      const rts   = t.public_metrics?.retweet_count || 0;
      return (likes + rts) >= 3; // filtra tweets sem engajamento
    })
    .sort((a, b) => {
      const engA = (a.public_metrics?.like_count || 0) + (a.public_metrics?.retweet_count || 0);
      const engB = (b.public_metrics?.like_count || 0) + (b.public_metrics?.retweet_count || 0);
      return engB - engA;
    })
    .slice(0, 5)
    .map((t) => ({
      text: t.text.replace(/https?:\/\/\S+/g, '').trim().substring(0, 240),
      likes: t.public_metrics?.like_count || 0,
      retweets: t.public_metrics?.retweet_count || 0,
    }));
}

// ─── Formatação para o prompt da IA ──────────────────────────────────────────

/**
 * Converte o objeto research em um bloco de texto para injetar no prompt.
 * A IA usa isso como matéria-prima criativa.
 */
function formatResearchForPrompt(research) {
  if (!research) return '';

  let block = '';

  // Contextos manuais do founder — prioridade máxima
  if (research.contexts?.length > 0) {
    block += `CONTEXTOS DO FOUNDER (prioridade máxima — incorpore nos posts):\n`;
    research.contexts.forEach((c, i) => {
      block += `${i + 1}. ${c.content}\n`;
    });
    block += '\n';
  }

  // Conteúdo RSS
  if (research.rssItems?.length > 0) {
    const topItems = research.rssItems.slice(0, 6);
    block += `CONTEÚDO FRESCO (RSS — use como inspiração, NÃO copie):\n`;
    topItems.forEach((item) => {
      block += `[${item.source}] ${item.title}`;
      if (item.snippet) {
        block += `\n→ ${item.snippet.substring(0, 160)}`;
      }
      block += '\n\n';
    });
  }

  // Insights do X
  if (research.xInsights?.length > 0) {
    block += `CONVERSAS EM ALTA NO X (pt-BR) — o que as pessoas estão dizendo agora:\n`;
    research.xInsights.forEach((t) => {
      const engagement = t.likes + t.retweets;
      block += `• "${t.text}" (${engagement} interações)\n`;
    });
    block += '\n';
  }

  if (!block) return '';

  return (
    `───────────────────────────────\n` +
    `PESQUISA AUTOMÁTICA:\n\n` +
    block +
    `───────────────────────────────\n` +
    `INSTRUÇÃO: use um ou mais itens acima como gancho, contraste ou contexto ` +
    `para criar um post ORIGINAL que conecte com a dor que o Myndit resolve. ` +
    `Não cite as fontes. Não copie frases. Inspire-se e escreva com a voz do Ícaro.\n`
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout após ${ms}ms: ${label}`)), ms)
  );
  return Promise.race([promise, timer]);
}

module.exports = { gatherResearch, formatResearchForPrompt, DEFAULT_SOURCES };
