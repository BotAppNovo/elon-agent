'use strict';

const OpenAI = require('openai');
const { getActiveContexts, getRecentPosts } = require('./db');
const { formatResearchForPrompt } = require('./research');
const { getLearningContext } = require('./metrics');

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

const SYSTEM_PROMPT = `Você é o ghostwriter do Ícaro Quinteiro, founder do Myndit — um app mobile que funciona como memória externa confiável.

MISSÃO DOS POSTS:
Falar com pessoas que sofrem de carga cognitiva no dia a dia — aquela sensação de ter pendências pequenas orbitando a cabeça sem parar, consumindo energia mental sem que a pessoa perceba. O objetivo é provocar identificação imediata: o leitor deve pensar "isso sou eu" antes de terminar a primeira linha.

PÚBLICO-ALVO:
- Quem fica repetindo mentalmente tarefas pequenas com medo de esquecer
- Quem manda mensagem para si mesmo no WhatsApp, cria alarmes sem contexto ou usa bloco de notas como gambiarra
- Empreendedores, autônomos, profissionais com rotina fragmentada e muitas responsabilidades simultâneas
- Quem sente aquela ansiedade difusa de "tenho uma coisa importante pra fazer mas não lembro o quê"

SOBRE O MYNDIT (contexto — não para citar diretamente em todo post):
- Resolve carga cognitiva contínua: a pessoa delega a pendência, o app guarda e insiste até ela resolver
- Slogan: "Eu lembro por você."
- NÃO é to-do list. É transferência real de responsabilidade cognitiva
- Diferencial: notificação persistente com insistência calibrada até confirmação explícita
- Promessa central: "Agora eu posso parar de pensar nisso"

VOZ DO ÍCARO:
- Direto, sem rodeios, fala como pensa
- Observador da própria experiência — usa o "eu" para criar identificação no "você"
- Tom que alterna entre reflexivo e provocativo
- Nunca soberbo, mas confiante
- Não usa emojis em excesso — máximo 1 por post se for completamente natural

REGRAS ABSOLUTAS (nunca violar):
1. ZERO hashtags — jamais
2. Sempre em primeira pessoa
3. Português brasileiro natural, sem formalidade acadêmica
4. Primeira linha PARA O SCROLL — gancho de identificação imediata, não de informação
5. NUNCA começar com: "Hoje quero falar sobre", "Vim aqui para", "Estou animado para compartilhar"
6. CRÍTICO: posts simples (opinion, question) têm no máximo 220 caracteres. Conte mentalmente antes de finalizar. Prefira uma ideia forte e curta a duas ideias comprimidas.
7. Se o conteúdo não couber em 220 caracteres, use formato thread automaticamente — NUNCA corte uma frase no meio
8. NUNCA mencionar métricas internas do app: D7, D30, número de usuários, retention, dados de beta
9. Posts que provocam comentário e identificação, não só like

REGRA DO MYNDIT NOS POSTS:
- Mencionar o Myndit no máximo em 1 a cada 3 posts — não em todo post
- Quando mencionar, focar na promessa emocional ("parar de pensar nisso", "delegar a responsabilidade"), nunca em features técnicas
- A maioria dos posts deve falar da DOR, não da solução — deixar o leitor chegar à solução por conta própria
- Nunca soar como propaganda — deve parecer reflexão genuína de quem viveu o problema

ÂNGULOS QUE FUNCIONAM (use como inspiração, não como template fixo):
- A sensação de não poder esquecer algo consome mais energia do que fazer a tarefa em si
- Toda vez que você manda mensagem para si mesmo no WhatsApp, seu cérebro está pedindo socorro
- Seu cérebro não foi feito para guardar lista. Foi feito para pensar.
- A pior parte não é esquecer. É ficar lembrando que não pode esquecer.
- Pequenas pendências não resolvidas criam uma ansiedade de fundo que a maioria não consegue nomear
- Alarme sem contexto é um lembrete que chegou cedo demais para ser útil

FORMATOS DISPONÍVEIS:
- "opinion": Observação ou opinião curta (1 tweet, máx 220 chars) — o mais comum, deve dominar o feed
- "question": Pergunta provocativa e direta (1 tweet, máx 220 chars) para gerar resposta nos comentários
- "thread": 3 a 6 tweets SEPARADOS, cada um com no máximo 240 chars, numerados (1/, 2/, 3/...)
- "poll": Enquete com pergunta + 2 a 4 opções curtas (máx 25 chars cada opção)

FORMATO DE RETORNO — sempre JSON válido:
{
  "format": "opinion|question|thread|poll",
  "content": "texto do post (para opinion/question) OU texto do 1° tweet (para thread) OU pergunta (para poll)",
  "tweets": ["1/ primeiro tweet", "2/ segundo tweet", "3/ terceiro tweet"],
  "poll_options": ["opção 1", "opção 2"]
}

REGRAS CRÍTICAS PARA THREAD:
- O campo "tweets" DEVE ser um array JSON com 3 a 6 strings — NUNCA null, NUNCA texto único
- Cada string do array é um tweet INDEPENDENTE e COMPLETO — máx 240 chars cada
- NUNCA coloque múltiplos tweets em uma única string do array
- NUNCA coloque todos os tweets concatenados no campo "content"
- Cada tweet já começa com o número: "1/ texto...", "2/ texto...", etc.
- Exemplo correto: {"format":"thread","content":"1/ Primeiro tweet aqui","tweets":["1/ Primeiro tweet aqui","2/ Segundo tweet aqui","3/ Terceiro tweet aqui"]}

Para formatos simples (opinion, question), "tweets" e "poll_options" devem ser null ou omitidos.`;

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
    userMessage += `Processe este input, extraia o ângulo mais interessante para o público e gere um post no melhor formato para o conteúdo. `;
    userMessage += `Foque em provocar identificação — o leitor deve se reconhecer antes de terminar a primeira linha.`;
  } else {
    userMessage += `Gere um post original sobre a dor que o Myndit resolve: carga cognitiva, pendências orbitando a cabeça, a ansiedade de não poder esquecer, as gambiarras que as pessoas usam (WhatsApp pra si mesmo, alarmes sem contexto). `;
    userMessage += `A maioria dos posts deve falar da DOR, não do app — só mencione o Myndit se os posts recentes ainda não mencionaram. `;
    userMessage += `Escolha o formato mais impactante e garanta variedade em relação ao histórico.`;
  }

  // Loop de aprendizado — injeta os melhores e piores posts recentes como referência
  try {
    const { top, worst } = await getLearningContext();
    if (top.length > 0) {
      userMessage += `\n\nPOSTS COM MELHOR DESEMPENHO NOS ÚLTIMOS 14 DIAS (use como inspiração de tom e formato — NUNCA repita o conteúdo):\n`;
      top.forEach((p, i) => {
        const snippet = p.content.substring(0, 120).replace(/\n/g, ' ');
        userMessage += `${i + 1}. [${p.format}] ${(p.impressions || 0).toLocaleString('pt-BR')} imp · ${p.likes || 0}❤️: "${snippet}"\n`;
      });
    }
    if (worst.length > 0) {
      userMessage += `\nPOSTS COM PIOR DESEMPENHO (evite esses padrões de tom e estrutura):\n`;
      worst.forEach((p, i) => {
        const snippet = p.content.substring(0, 80).replace(/\n/g, ' ');
        userMessage += `${i + 1}. [${p.format}] ${(p.impressions || 0).toLocaleString('pt-BR')} imp: "${snippet}"\n`;
      });
    }
  } catch {
    // Métricas ainda não disponíveis — ignora silenciosamente
  }

  userMessage += `\n\nLEMBRETE CRÍTICO: se o formato for opinion ou question, o campo "content" DEVE ter no máximo 220 caracteres. Conte agora antes de responder. Se não couber, use format=thread.`;
  userMessage += `\n\nLEMBRETE CRÍTICO PARA THREAD: o campo "tweets" DEVE ser um array JSON com 3 a 6 strings independentes (máx 240 chars cada). NUNCA coloque os tweets como texto único ou concatenado no campo "content". Cada elemento do array é um tweet separado.`;
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

  const normalized = normalizePost(post);

  // Validação pós-normalização: se post simples ainda exceder 240 chars, reescrever
  if (
    normalized.content &&
    normalized.format !== 'thread' &&
    normalized.format !== 'poll' &&
    normalized.content.length > 240
  ) {
    console.log(`[ai] Post excedeu limite (${normalized.content.length} chars), reescrevendo...`);

    let rewritten = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      rewritten = await rewriteToFitLimit(normalized.content);
      if (rewritten && rewritten.length <= 280) {
        console.log(`[ai] Reescrita tentativa ${attempt}: ${rewritten.length} chars — ok`);
        normalized.content = rewritten;
        break;
      }
      console.warn(`[ai] Reescrita tentativa ${attempt} ainda longa (${rewritten?.length ?? 'null'} chars)`);
      rewritten = null;
    }

    if (!rewritten) {
      // Após 2 tentativas falhas, converte para thread
      console.warn('[ai] Reescrita falhou 2x — convertendo para thread');
      const sentences = normalized.content.match(/[^.!?]+[.!?]*/g) || [normalized.content];
      const mid = Math.ceil(sentences.length / 2);
      normalized.format = 'thread';
      normalized.tweets = [
        `1/ ${sentences.slice(0, mid).join(' ').trim()}`,
        `2/ ${sentences.slice(mid).join(' ').trim()}`,
      ].filter((t) => t.replace(/^\d+\/ /, '').trim().length > 0);
      normalized.content = normalized.tweets[0];
    }
  }

  return normalized;
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

/**
 * Pede para a IA reescrever um post simples dentro do limite de 220 chars.
 * Retorna o texto reescrito, ou null em caso de falha.
 */
async function rewriteToFitLimit(text) {
  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Você é um editor de posts para X (Twitter). Reescreva o post abaixo em no máximo 220 caracteres, preservando a ideia central e o tom. Retorne APENAS o texto reescrito, sem aspas, sem JSON, sem explicação.' },
        { role: 'user', content: text },
      ],
      temperature: 0.5,
      max_tokens: 120,
    });
    const rewritten = (response.choices[0].message.content || '').trim();
    return rewritten.length > 0 ? rewritten : null;
  } catch (err) {
    console.error('[ai] Erro na reescrita de post longo:', err.message);
    return null;
  }
}

/**
 * Tenta extrair tweets individuais de um texto corrido que contém numeração (1/, 2/, 3/...).
 * Usado como fallback quando a IA retorna tweets concatenados em vez de array.
 */
function extractThreadFromContent(text) {
  if (!text) return null;
  // Divide nas marcações numéricas de thread (1/, 2/, 3/ ou 1. 2. 3.)
  const parts = text.split(/\n(?=\d+[\/\.])/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;
  return null;
}

function normalizePost(post) {
  const validFormats = ['opinion', 'question', 'thread', 'poll'];
  if (!validFormats.includes(post.format)) {
    post.format = 'opinion';
  }

  if (!post.content) post.content = '';

  if (post.format === 'thread') {
    let tweets = post.tweets;
    if (!Array.isArray(tweets) || tweets.length < 2) {
      // Tenta extrair tweets do campo content (ex: "1/ texto\n2/ texto...")
      tweets = extractThreadFromContent(post.content);
    }
    if (!tweets || tweets.length < 2) {
      // Degrada para opinião
      console.warn('[ai] Thread sem array válido de tweets — degradando para opinion. content:', post.content?.substring(0, 100));
      post.format = 'opinion';
      post.tweets = null;
    } else {
      post.tweets = tweets.map((t) => String(t).trim());
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
// System prompt LinkedIn
// ─────────────────────────────────────────────

const LINKEDIN_SYSTEM_PROMPT = `Você escreve posts para a página do Myndit no LinkedIn.

SOBRE O MYNDIT:
O Myndit é a primeira ferramenta brasileira de memória externa cognitiva. Slogan: "Eu lembro por você." Não é app de lembretes — é transferência real de responsabilidade cognitiva. O app insiste até o usuário resolver a pendência. 3 modos de intensidade: Padrão, Moderado, Intenso.

PÚBLICO:
Empresário PME, advogado, médico com consultório próprio, consultor autônomo. 28–45 anos. Gerencia a própria agenda sem assistente. Usa WhatsApp, alarme ou bloco de notas como gambiarra para não esquecer.

TOM DE VOZ:
Sóbrio, humano, direto. Como um assistente discreto e confiante. Sem exclamações, sem emojis, sem jargão de produtividade ou wellness. O leitor deve sentir que o produto entende o problema dele.

NUNCA USE:
- "revolucionário", "inovador", "disruptivo", "paz mental"
- Linguagem de saúde mental ou terapia
- Gamificação, contadores, desafios
- Textos genéricos de produtividade que poderiam ser de qualquer marca
- Urgência artificial
- Emojis

ESTRUTURA DOS POSTS:
- Comece sempre com a dor — nunca com o produto
- 80 a 200 palavras
- Parágrafos curtos, máximo 2 linhas cada
- Mencione o Myndit apenas no final, se fizer sentido orgânico
- Máximo 1 menção ao Myndit por post

EXEMPLO DE POST BOM:
"A maioria das pessoas tem pelo menos três sistemas para não esquecer as coisas.

Um alarme no celular. Uma mensagem para si mesmo no WhatsApp. Um post-it no monitor.

E ainda assim esquecem.

Não é falta de organização. É que nenhuma dessas gambiarras insiste. Elas avisam uma vez — e somem.

O Myndit não some. Ele lembra até você resolver. Depois para, sem culpa.

Cabeça mais leve. Todo dia."

TEMAS PARA VARIAR:
1. Espelho da dor — situações específicas que o público vive (a ligação esquecida, a tarefa que ficou na cabeça três dias, o loop mental de "não posso esquecer disso")
2. Diferenciação — por que lembrete comum não resolve, a diferença entre ser avisado uma vez e ter algo que insiste com calma
3. Prova — como o app funciona na prática, bastidores do produto`;

// ─────────────────────────────────────────────
// LinkedIn — versão adaptada do post do X
// ─────────────────────────────────────────────

/**
 * Recebe o post do X (já publicado) e gera uma versão original para o LinkedIn
 * com o mesmo tema, usando o tom e as regras do LINKEDIN_SYSTEM_PROMPT.
 */
async function generateLinkedInVersion(xPost) {
  const xText = postToText(xPost);

  const userMessage =
    `O Myndit acabou de publicar este conteúdo no X:\n\n${xText}\n\n` +
    `Com base no mesmo tema, escreva um post original para o LinkedIn seguindo exatamente as regras do seu prompt.\n` +
    `Não copie o texto do X — escreva de forma independente, com a profundidade e o tom adequados ao LinkedIn.\n\n` +
    `Retorne APENAS o texto do post. Sem JSON, sem aspas, sem markdown, sem explicação.`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LINKEDIN_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.85,
    max_tokens: 600,
  });

  return response.choices[0].message.content.trim().substring(0, 3000);
}

// ─────────────────────────────────────────────
// LinkedIn — post autônomo (sem base em X)
// ─────────────────────────────────────────────

/**
 * Gera um post original para o LinkedIn sem base em nenhum post do X.
 * Usado pelo cron de segundas, quartas e sextas às 9h.
 */
async function generateLinkedInPost() {
  const userMessage =
    `Escreva um post original para o LinkedIn seguindo exatamente as regras do seu prompt.\n\n` +
    `Retorne APENAS o texto do post. Sem JSON, sem aspas, sem markdown, sem explicação.`;

  const response = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: LINKEDIN_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.85,
    max_tokens: 600,
  });

  return response.choices[0].message.content.trim().substring(0, 3000);
}

module.exports = { generatePost, improvePost, generateLinkedInVersion, generateLinkedInPost };
