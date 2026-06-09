'use strict';

const OpenAI = require('openai');
const { getActiveContexts, getRecentPosts } = require('./db');
const { formatResearchForPrompt } = require('./research');

let openaiClient;

function getClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ─────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é o ghostwriter do Ícaro Quinteiro, founder do Myndit — um app mobile de apoio cognitivo.

SOBRE O MYNDIT:
- Resolve carga cognitiva contínua: pequenas pendências que ficam orbitando a cabeça, consumindo energia mental
- Slogan: "Eu lembro por você."
- NÃO é to-do list. É transferência real de responsabilidade cognitiva
- Diferencial: notificação persistente com insistência calibrada até confirmação explícita
- 3 perfis de intensidade: Padrão (3 re-notificações), Moderado (6), Intenso (12) — todas de 10 em 10 minutos
- Stack: React Native + Expo, Supabase, RevenueCat, PostHog
- Beta fechado concluído: 42 usuários, D7 retention 40,5%, D30 retention 33%
- Frases reais de usuários: "Limpei minha mente de coisas que ficaria repetindo mil vezes", "O app insiste na dose certa, sem encher o saco", "Posso viver mais sem ele não", "Boyyyy se fosse um valor baixo eu passaria o cartão e nunca mais cancelaria"
- Preço: R$19,90/mês ou R$149,90/ano

VOZ DO ÍCARO:
- Direto, sem rodeios, fala como pensa
- Dono do problema, nunca espectador
- Cita métricas reais sem fanfarra
- Tom que alterna entre reflexivo e provocativo
- Nunca soberbo, mas confiante
- Não usa emojis em excesso — máximo 1 por post se for natural

REGRAS ABSOLUTAS (nunca violar):
1. ZERO hashtags — jamais
2. Sempre em primeira pessoa
3. Português brasileiro natural, sem formalidade acadêmica
4. Primeira linha PARA O SCROLL — gancho forte, curiosidade ou identificação imediata
5. NUNCA começar com: "Hoje quero falar sobre", "Vim aqui para", "Estou animado para compartilhar"
6. Cada tweet tem no máximo 280 caracteres
7. Dados e métricas reais quando disponíveis
8. Posts que provocam comentário, não só like

FORMATOS DISPONÍVEIS:
- "opinion": Post de opinião curto (1 tweet). Ex: "Eu acredito que...", "Na minha visão...", "Depois de X meses..."
- "question": Pergunta provocativa curta para gerar resposta nos comentários
- "thread": 3 a 6 tweets numerados (1/, 2/...) para conteúdo denso que merece profundidade
- "poll": Enquete com pergunta + 2 a 4 opções curtas (máx 25 chars cada opção)
- "metric": Post de dado real em primeira pessoa. Ex: "Nosso D7 chegou em 40,5%..."

FORMATO DE RETORNO — sempre JSON válido:
{
  "format": "opinion|question|thread|poll|metric",
  "content": "texto do post (ou do 1° tweet se thread, ou da pergunta se poll)",
  "tweets": ["1° tweet", "2° tweet", ...],  // apenas se format=thread
  "poll_options": ["opção 1", "opção 2"]    // apenas se format=poll, 2-4 opções
}

Para formatos simples (opinion, question, metric), "tweets" e "poll_options" devem ser null ou omitidos.`;

// ─────────────────────────────────────────────
// Geração principal
// ─────────────────────────────────────────────

async function generatePost(input = null, research = null) {
  // Quando research é fornecido (via cron), ele já contém os contextos.
  // Para posts manuais, buscamos os contextos diretamente do DB.
  const contexts = research ? [] : await getActiveContexts(6);
  const recentPosts = await getRecentPosts(15);

  // Mapeia contagem de formatos recentes para forçar variedade
  const formatCounts = recentPosts.reduce((acc, p) => {
    acc[p.format] = (acc[p.format] || 0) + 1;
    return acc;
  }, {});

  // Evita repetir os últimos 2 formatos consecutivos
  const lastFormats = recentPosts.slice(0, 2).map((p) => p.format);
  const avoidFormats = [...new Set(lastFormats)];

  const recentSnippets = recentPosts
    .slice(0, 8)
    .map((p) => `[${p.format}] ${p.content.substring(0, 90)}`)
    .join('\n');

  let userMessage = '';

  // Injeta bloco de pesquisa automática (apenas no cron)
  if (research) {
    const researchBlock = formatResearchForPrompt(research);
    if (researchBlock) {
      userMessage += researchBlock + '\n';
    }
  }

  if (contexts.length > 0) {
    userMessage += `CONTEXTOS RECENTES DO FOUNDER (use com peso maior nos mais recentes):\n`;
    contexts.forEach((c, i) => {
      userMessage += `${i + 1}. ${c.content}\n`;
    });
    userMessage += '\n';
  }

  if (Object.keys(formatCounts).length > 0) {
    userMessage += `FORMATOS USADOS RECENTEMENTE (variar):\n${JSON.stringify(formatCounts)}\n`;
    if (avoidFormats.length > 0) {
      userMessage += `FORMATOS A EVITAR AGORA (últimos 2 usados): ${avoidFormats.join(', ')}\n`;
    }
    userMessage += '\n';
  }

  if (recentPosts.length > 0) {
    userMessage += `POSTS RECENTES (NAO REPETIR TEMAS):\n${recentSnippets}\n\n`;
  }

  if (input) {
    userMessage += `INPUT DO FOUNDER PARA BASEAR O POST:\n${input}\n\n`;
    userMessage += `Processe este input, extraia o ângulo mais interessante para o público do X e gere um post no melhor formato para o conteúdo.`;
  } else {
    userMessage += `Gere um post original sobre o Myndit ou sobre o problema que ele resolve (carga cognitiva, esquecimento, pendências mentais).`;
    userMessage += ` Escolha o formato mais impactante para o momento e garanta variedade em relação ao histórico.`;
  }

  userMessage += `\n\nRetorne SOMENTE o JSON sem markdown ou blocos de código.`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.88,
    max_tokens: 1200,
  });

  const raw = response.choices[0].message.content;
  let post;

  try {
    post = JSON.parse(raw);
  } catch {
    // Fallback se o JSON vier mal formatado
    console.error('[ai] JSON invalido do modelo:', raw);
    throw new Error('Modelo retornou JSON invalido. Tente novamente.');
  }

  return normalizePost(post);
}

// ─────────────────────────────────────────────
// Melhoria de post via feedback
// ─────────────────────────────────────────────

async function improvePost(post, feedback) {
  const original = postToText(post);

  const userMessage =
    `Post original:\n${original}\n\n` +
    `Feedback: ${feedback}\n\n` +
    `Melhore o post respeitando o feedback. Mantenha o mesmo formato se fizer sentido, ou mude se o feedback indicar isso. ` +
    `Retorne SOMENTE o JSON sem markdown ou blocos de código.`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.8,
    max_tokens: 1200,
  });

  const raw = response.choices[0].message.content;
  return normalizePost(JSON.parse(raw));
}

// ─────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────

function normalizePost(post) {
  const validFormats = ['opinion', 'question', 'thread', 'poll', 'metric'];
  if (!validFormats.includes(post.format)) {
    post.format = 'opinion';
  }

  if (!post.content) post.content = '';

  if (post.format === 'thread') {
    if (!Array.isArray(post.tweets) || post.tweets.length < 2) {
      // Degrada para opinião
      post.format = 'opinion';
      post.tweets = null;
    } else {
      // Garante que cada tweet respeita 280 chars
      post.tweets = post.tweets.map((t) => t.substring(0, 280));
      post.content = post.tweets[0];
    }
  } else {
    post.tweets = null;
  }

  if (post.format === 'poll') {
    if (!Array.isArray(post.poll_options) || post.poll_options.length < 2) {
      post.format = 'question';
      post.poll_options = null;
    } else {
      post.poll_options = post.poll_options
        .slice(0, 4)
        .map((o) => String(o).substring(0, 25));
    }
  } else {
    post.poll_options = null;
  }

  // Garante 280 chars no content
  if (post.content && post.format !== 'thread') {
    post.content = post.content.substring(0, 280);
  }

  return post;
}

function postToText(post) {
  if (post.format === 'thread' && post.tweets?.length) {
    return post.tweets.map((t, i) => `${i + 1}/ ${t}`).join('\n\n');
  }
  if (post.format === 'poll' && post.poll_options?.length) {
    return `${post.content}\n${post.poll_options.map((o) => `- ${o}`).join('\n')}`;
  }
  return post.content;
}

// ─────────────────────────────────────────────
// Versão LinkedIn (expandida)
// ─────────────────────────────────────────────

/**
 * Recebe o post do X (já gerado) e retorna uma versão expandida para o LinkedIn.
 * LinkedIn suporta até 3.000 chars. Visamos 800–1.500.
 */
async function generateLinkedInVersion(xPost) {
  const xText = postToText(xPost);

  const userMessage =
    `Post publicado no X:\n${xText}\n\n` +
    `Adapte este post para o LinkedIn. Regras:\n` +
    `1. Mesma voz do Ícaro — 1ª pessoa, direto, sem enrolação\n` +
    `2. Primeira linha ainda mais forte (é o que aparece antes do "ver mais")\n` +
    `3. Expanda a ideia central em 3–4 parágrafos curtos com quebra de linha entre eles\n` +
    `4. Mais contexto e profundidade que no X, mas sem virar artigo acadêmico\n` +
    `5. ZERO hashtags\n` +
    `6. Termine com uma frase que convida reflexão ou comentário\n` +
    `7. Máximo 1500 caracteres\n\n` +
    `Retorne APENAS o texto do post. Sem JSON, sem aspas, sem markdown, sem explicação.`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.85,
    max_tokens: 700,
  });

  return response.choices[0].message.content.trim().substring(0, 1500);
}

module.exports = { generatePost, improvePost, generateLinkedInVersion };
