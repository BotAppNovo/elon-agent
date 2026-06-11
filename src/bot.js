'use strict';

const { Telegraf } = require('telegraf');
const { generatePost, improvePost } = require('./ai');
const { publish, normalizeIds, rawResponse, tweetUrl } = require('./publisher');
const {
  savePost,
  getSetting,
  saveSetting,
  saveContext,
  listContexts,
  getRecentPosts,
  clearContexts,
  getRssSources,
  saveRssSource,
  removeRssSource,
  markTweetSkipped,
} = require('./db');
const { DEFAULT_SOURCES } = require('./research');
const { formatPostPreview, getNextScheduledPost, parseEditedText, postToStorableContent, escHtml } = require('./utils');
const {
  startCopilot,
  runCopilotSearch,
  copilotPendingApprovals,
  copilotKeyboard,
  buildSuggestionMessage,
  buildIntentUrl,
  buildQuoteIntentUrl,
  skipTweet,
} = require('./copilot');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const X_USERNAME = process.env.X_USERNAME || null;

// ─── Estado em memória ───────────────────────────────────────────────────────

// postId -> { post, source, messageId }
const pendingApprovals = new Map();

// chatId -> { postId?, copilotId?, step }
const editingState = new Map();

// ─── Middleware de segurança ─────────────────────────────────────────────────

bot.use((ctx, next) => {
  const chatId = ctx.chat?.id?.toString();
  if (chatId !== OWNER_CHAT_ID) {
    console.warn(`[bot] Acesso nao autorizado de chatId=${chatId}`);
    return; // ignora silenciosamente
  }
  return next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function newPostId() {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function approvalKeyboard(postId) {
  return {
    inline_keyboard: [[
      { text: '✅ Aprovar', callback_data: `approve:${postId}` },
      { text: '✏️ Editar', callback_data: `edit:${postId}` },
      { text: '❌ Descartar', callback_data: `discard:${postId}` },
    ]],
  };
}

function approveOnlyKeyboard(postId) {
  return {
    inline_keyboard: [[
      { text: '✅ Aprovar', callback_data: `approve:${postId}` },
      { text: '❌ Descartar', callback_data: `discard:${postId}` },
    ]],
  };
}

async function doPublish(post, source) {
  console.log('[bot] Iniciando publicação no X...');
  console.log('[bot] Formato:', post.format);
  console.log('[bot] Texto completo do post:\n' + formatPostPreview(post));

  const result = await publish(post);
  const xIds = normalizeIds(result);
  const xRaw = rawResponse(result);

  console.log('[bot] Resposta da API do X — IDs publicados:', xIds);
  console.log('[bot] Resposta raw da API do X:', JSON.stringify(xRaw, null, 2));

  await savePost({
    content: postToStorableContent(post),
    format: post.format,
    tweet_ids: xIds,
    source,
    linkedin_post_id: null,
  });

  return { xIds };
}

function buildPublishedMessage(post, xIds) {
  const preview = formatPostPreview(post);
  const xUrl = tweetUrl(xIds[0], X_USERNAME);
  return `✅ <b>Publicado no X!</b>\n\n${preview}\n\n<a href="${xUrl}">Ver no X</a>`;
}

// ─── sendForApproval — usado pelo scheduler e por comandos manuais ────────────

async function sendForApproval(post, source = 'manual') {
  const postId = newPostId();
  const preview = formatPostPreview(post);

  const message = await bot.telegram.sendMessage(
    OWNER_CHAT_ID,
    `📝 <b>Post gerado</b>\n\n${preview}`,
    {
      parse_mode: 'HTML',
      reply_markup: approvalKeyboard(postId),
    }
  );

  pendingApprovals.set(postId, { post, source, messageId: message.message_id });
  return message;
}

// ─── Comandos ────────────────────────────────────────────────────────────────

bot.command('start', (ctx) => {
  ctx.replyWithHTML(
    `<b>Agente Elon ativo.</b>\n\n` +
    `Envie qualquer texto, link ou legenda de imagem para gerar um post para o X.\n\n` +
    `<b>Comandos:</b>\n` +
    `/auto on — Liga modo autônomo (publica direto)\n` +
    `/auto off — Desliga modo autônomo (pede aprovação)\n` +
    `/status — Ver configurações e próximo post\n` +
    `/gerar — Gerar post agora (sem input)\n` +
    `/contexto [texto] — Adicionar contexto ao agente\n` +
    `/historico — Ver últimos 5 posts publicados\n` +
    `/limpar_contextos — Remove todos os contextos salvos\n` +
    `/fontes — Ver e gerenciar fontes de RSS\n` +
    `/copilot on|off — Liga/desliga buscas de resposta\n` +
    `/copilot agora — Força busca imediata`
  );
});

bot.command('auto', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const action = (args[0] || '').toLowerCase();

  if (action === 'on') {
    await saveSetting('autonomous_mode', 'true');
    ctx.replyWithHTML(
      `🟢 <b>Modo autônomo ATIVADO</b>\n` +
      `Posts serão publicados direto no X sem pedir aprovação.`
    );
  } else if (action === 'off') {
    await saveSetting('autonomous_mode', 'false');
    ctx.replyWithHTML(
      `🔴 <b>Modo autônomo DESATIVADO</b>\n` +
      `Posts serão enviados aqui para aprovação antes de publicar.`
    );
  } else {
    const isOn = (await getSetting('autonomous_mode')) === 'true';
    ctx.replyWithHTML(
      `Modo autônomo: <b>${isOn ? '🟢 ON' : '🔴 OFF'}</b>\n\nUse <code>/auto on</code> ou <code>/auto off</code>`
    );
  }
});

bot.command('copilot', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const action = (args[0] || '').toLowerCase();

  if (action === 'on') {
    await saveSetting('copilot_enabled', 'true');
    ctx.replyWithHTML(`🟢 <b>Copiloto ATIVADO</b>\nBuscas automáticas às 11h e 19h (Brasília).`);
  } else if (action === 'off') {
    await saveSetting('copilot_enabled', 'false');
    ctx.replyWithHTML(`🔴 <b>Copiloto DESATIVADO</b>\nBuscas automáticas pausadas.`);
  } else if (action === 'agora') {
    const loadingMsg = await ctx.reply('🔍 Buscando tweets...');
    try {
      await runCopilotSearch(bot.telegram);
      await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
      ctx.replyWithHTML(`✅ Busca concluída — sugestões enviadas acima (se encontrou tweets elegíveis).`);
    } catch (err) {
      await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
      ctx.replyWithHTML(`❌ <b>Erro na busca:</b> ${escHtml(err.message)}`);
    }
  } else {
    const isOn = (await getSetting('copilot_enabled')) !== 'false';
    ctx.replyWithHTML(
      `Copiloto: <b>${isOn ? '🟢 ON' : '🔴 OFF'}</b>\n\n` +
      `<code>/copilot on</code> — Ativar\n` +
      `<code>/copilot off</code> — Desativar\n` +
      `<code>/copilot agora</code> — Buscar agora`
    );
  }
});

bot.command('status', async (ctx) => {
  const isAuto = (await getSetting('autonomous_mode')) === 'true';
  const isCopilot = (await getSetting('copilot_enabled')) !== 'false';
  const contexts = await listContexts();
  const nextPost = getNextScheduledPost();

  let text =
    `<b>Status — Agente Elon</b>\n\n` +
    `Modo autônomo: <b>${isAuto ? '🟢 ON' : '🔴 OFF'}</b>\n` +
    `Copiloto: <b>${isCopilot ? '🟢 ON' : '🔴 OFF'}</b>\n` +
    `Próximo post: <b>${nextPost}</b>\n` +
    `Horários: 8h · 10h · 13h · 17h · 20h (Brasília)\n\n`;

  if (contexts.length > 0) {
    text += `<b>Contextos ativos (${contexts.length}):</b>\n`;
    contexts.slice(0, 6).forEach((c, i) => {
      const snippet = c.content.length > 85 ? c.content.substring(0, 85) + '…' : c.content;
      text += `${i + 1}. ${escHtml(snippet)}\n`;
    });
    if (contexts.length > 6) {
      text += `<i>…e mais ${contexts.length - 6} contextos</i>`;
    }
  } else {
    text += `Nenhum contexto salvo ainda.`;
  }

  ctx.replyWithHTML(text);
});

bot.command('contexto', async (ctx) => {
  const rawText = ctx.message.text.replace(/^\/contexto\s*/i, '').trim();

  if (!rawText) {
    return ctx.replyWithHTML(
      `Use: <code>/contexto [texto]</code>\n\n` +
      `Exemplo: <code>/contexto lançamos v1.1 com recorrência e modo offline</code>\n\n` +
      `O contexto é salvo e usado pela IA nos próximos posts.`
    );
  }

  await saveContext(rawText);
  ctx.replyWithHTML(`✅ <b>Contexto salvo:</b>\n<i>${escHtml(rawText)}</i>`);
});

bot.command('limpar_contextos', async (ctx) => {
  await clearContexts();
  ctx.replyWithHTML(`🗑 Todos os contextos foram removidos.`);
});

bot.command('historico', async (ctx) => {
  const posts = await getRecentPosts(5);

  if (posts.length === 0) {
    return ctx.replyWithHTML(`Nenhum post publicado ainda.`);
  }

  let text = `<b>Últimos posts publicados:</b>\n\n`;

  posts.forEach((p, i) => {
    const date = new Date(p.published_at).toLocaleDateString('pt-BR');
    const snippet = p.content.length > 100 ? p.content.substring(0, 100) + '…' : p.content;
    const xIds = JSON.parse(p.tweet_ids || '[]');

    const links = [];
    if (xIds[0]) links.push(`<a href="${tweetUrl(xIds[0], X_USERNAME)}">X</a>`);
    const linkStr = links.length ? ` — ${links.join(' · ')}` : '';

    text += `<b>${i + 1}. [${p.format}]</b> ${date}${linkStr}\n${escHtml(snippet)}\n\n`;
  });

  ctx.replyWithHTML(text, { disable_web_page_preview: true });
});

bot.command('fontes', async (ctx) => {
  const args = ctx.message.text.replace(/^\/fontes\s*/i, '').trim();

  // /fontes add <url> <nome>
  if (args.toLowerCase().startsWith('add ')) {
    const rest = args.slice(4).trim();
    const urlMatch = rest.match(/^(https?:\/\/\S+)\s+(.*)/);
    if (!urlMatch) {
      return ctx.replyWithHTML(
        `Uso: <code>/fontes add https://url.com Nome do Feed</code>\n\nExemplo:\n<code>/fontes add https://blog.exemplo.com/feed Meu Blog</code>`
      );
    }
    const [, url, name] = urlMatch;
    await saveRssSource(name.trim(), url);
    return ctx.replyWithHTML(`✅ <b>Fonte adicionada:</b> ${escHtml(name.trim())}\n<code>${escHtml(url)}</code>`);
  }

  // /fontes remover <id>
  if (args.toLowerCase().startsWith('remover ')) {
    const id = parseInt(args.slice(8).trim(), 10);
    if (isNaN(id)) {
      return ctx.replyWithHTML(`Uso: <code>/fontes remover [id]</code>\n\nObtena o ID com <code>/fontes</code>`);
    }
    await removeRssSource(id);
    return ctx.replyWithHTML(`🗑 Fonte <code>${id}</code> removida.`);
  }

  // /fontes — listar tudo
  const userSources = await getRssSources();
  const researchEnabled = process.env.RESEARCH_ENABLED !== 'false';

  let text = `<b>Fontes de RSS</b>\n`;
  text += `Pesquisa automática: <b>${researchEnabled ? '🟢 ON' : '🔴 OFF'}</b>\n\n`;

  text += `<b>Padrão (${DEFAULT_SOURCES.length}):</b>\n`;
  DEFAULT_SOURCES.forEach((s) => {
    text += `• <b>${escHtml(s.name)}</b> — ${escHtml(s.desc)}\n`;
  });

  if (userSources.length > 0) {
    text += `\n<b>Suas fontes (${userSources.length}):</b>\n`;
    userSources.forEach((s) => {
      text += `[${s.id}] <b>${escHtml(s.name)}</b>\n<code>${escHtml(s.url)}</code>\n`;
    });
  } else {
    text += `\nNenhuma fonte customizada adicionada ainda.`;
  }

  text += `\n\n<b>Adicionar fonte:</b>\n<code>/fontes add https://url.com Nome</code>`;
  text += `\n<b>Remover fonte:</b>\n<code>/fontes remover [id]</code>`;

  ctx.replyWithHTML(text, { disable_web_page_preview: true });
});

bot.command('gerar', async (ctx) => {
  const loadingMsg = await ctx.reply('⏳ Gerando post...');

  try {
    const post = await generatePost();
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    await handleGeneratedPost(ctx, post, 'manual');
  } catch (err) {
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    ctx.replyWithHTML(`❌ <b>Erro:</b> ${escHtml(err.message)}`);
  }
});

// ─── Mensagens de texto (input para geração) ──────────────────────────────────

bot.on('text', async (ctx) => {
  const text = ctx.message.text || '';
  const chatId = ctx.chat.id.toString();

  // Ignora comandos (são tratados acima)
  if (ctx.message.entities?.some((e) => e.type === 'bot_command')) return;

  // Modo de edição: esperando texto editado do usuário
  const editState = editingState.get(chatId);
  if (editState) {
    editingState.delete(chatId);
    if (editState.step === 'awaiting_copilot_edit') {
      await handleCopilotEditReply(ctx, text, editState);
    } else {
      await handleEditReply(ctx, text, editState);
    }
    return;
  }

  // Geração normal a partir do input
  const loadingMsg = await ctx.reply('⏳ Processando...');
  try {
    const post = await generatePost(text);
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    await handleGeneratedPost(ctx, post, 'manual');
  } catch (err) {
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    ctx.replyWithHTML(`❌ <b>Erro:</b> ${escHtml(err.message)}`);
  }
});

// ─── Fotos (usa legenda como input) ──────────────────────────────────────────

bot.on('photo', async (ctx) => {
  const caption = ctx.message.caption || '';
  const loadingMsg = await ctx.reply('⏳ Processando imagem...');

  try {
    const post = await generatePost(caption || null);
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    await handleGeneratedPost(ctx, post, 'manual');
  } catch (err) {
    await ctx.deleteMessage(loadingMsg.message_id).catch(() => {});
    ctx.replyWithHTML(`❌ <b>Erro:</b> ${escHtml(err.message)}`);
  }
});

// ─── Callbacks dos botões — Posts X ──────────────────────────────────────────

// Aprovar → publicar
bot.action(/^approve:(.+)$/, async (ctx) => {
  const postId = ctx.match[1];

  console.log(`[bot] Aprovação recebida para post ID: ${postId}`);

  await ctx.answerCbQuery('Publicando...').catch(() => {});

  const pending = pendingApprovals.get(postId);
  if (!pending) {
    console.warn(`[bot] Post ID ${postId} não encontrado em pendingApprovals (bot pode ter reiniciado)`);
    return ctx.editMessageText('❌ Post não encontrado (bot pode ter reiniciado).').catch(() => {});
  }

  try {
    const { xIds } = await doPublish(pending.post, pending.source);
    pendingApprovals.delete(postId);

    console.log(`[bot] Publicação concluída — tweet IDs: ${xIds.join(', ')}`);

    const successMsg = buildPublishedMessage(pending.post, xIds);
    await ctx.editMessageText(successMsg, {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }).catch(() => {});
  } catch (err) {
    console.error('[bot] Erro ao publicar — mensagem:', err.message);
    console.error('[bot] Erro ao publicar — stack:\n', err.stack);

    const errMsg =
      `❌ <b>Falha ao publicar post ID ${escHtml(postId)}</b>\n\n` +
      `<b>Erro:</b> ${escHtml(err.message)}\n\n` +
      `<i>Verifique os logs do servidor para o stack trace completo.</i>`;

    await ctx.editMessageText(errMsg, { parse_mode: 'HTML' }).catch(() => {});
    await bot.telegram
      .sendMessage(OWNER_CHAT_ID, errMsg, { parse_mode: 'HTML' })
      .catch(() => {});
  }
});

// Editar → entrar em modo de edição
bot.action(/^edit:(.+)$/, async (ctx) => {
  const postId = ctx.match[1];
  const chatId = ctx.chat.id.toString();

  await ctx.answerCbQuery().catch(() => {});

  const pending = pendingApprovals.get(postId);
  if (!pending) {
    return ctx.editMessageText('❌ Post não encontrado.').catch(() => {});
  }

  editingState.set(chatId, { postId, step: 'awaiting_edit' });

  const { format } = pending.post;
  let hint = '';
  if (format === 'thread') {
    hint = '\n\n<i>Para thread: envie os tweets numerados:\n1/ primeiro tweet\n2/ segundo tweet</i>';
  } else if (format === 'poll') {
    hint = '\n\n<i>Para enquete:\nEscreva a pergunta na 1a linha\n- opção 1\n- opção 2</i>';
  }

  await ctx.replyWithHTML(`✏️ <b>Envie o texto editado:</b>${hint}`);
});

// Descartar
bot.action(/^discard:(.+)$/, async (ctx) => {
  const postId = ctx.match[1];
  await ctx.answerCbQuery('Descartado').catch(() => {});
  pendingApprovals.delete(postId);
  await ctx.editMessageText('❌ Post descartado.').catch(() => {});
});

// ─── Callbacks copiloto ───────────────────────────────────────────────────────

// Editar resposta
bot.action(/^copilot_edit:(.+)$/, async (ctx) => {
  const copilotId = ctx.match[1];
  const chatId = ctx.chat.id.toString();
  await ctx.answerCbQuery().catch(() => {});

  const pending = copilotPendingApprovals.get(copilotId);
  if (!pending) {
    return ctx.editMessageText('❌ Sugestão não encontrada.').catch(() => {});
  }

  editingState.set(chatId, { step: 'awaiting_copilot_edit', copilotId });
  await ctx.replyWithHTML(
    `✏️ <b>Envie o texto editado para a resposta:</b>\n\n<i>Máx 200 caracteres · sem hashtags · sem links</i>`
  );
});

// Pular
bot.action(/^copilot_skip:(.+)$/, async (ctx) => {
  const copilotId = ctx.match[1];
  await ctx.answerCbQuery('Pulado').catch(() => {});

  const pending = copilotPendingApprovals.get(copilotId);
  if (pending) {
    await skipTweet(pending.tweetId).catch(() => {});
    copilotPendingApprovals.delete(copilotId);
  }
  await ctx.editMessageText('❌ Sugestão descartada.').catch(() => {});
});

// ─── Handlers internos ────────────────────────────────────────────────────────

async function handleGeneratedPost(ctx, post, source) {
  const isAuto = (await getSetting('autonomous_mode')) === 'true';

  if (isAuto) {
    try {
      const { xIds } = await doPublish(post, source);
      const msg = buildPublishedMessage(post, xIds);
      await ctx.replyWithHTML(msg, { disable_web_page_preview: false });
    } catch (err) {
      ctx.replyWithHTML(`❌ <b>Erro ao publicar:</b> ${escHtml(err.message)}`);
    }
  } else {
    await sendForApproval(post, source);
  }
}

async function handleEditReply(ctx, editedText, editState) {
  const { postId } = editState;
  const pending = pendingApprovals.get(postId);

  if (!pending) {
    return ctx.replyWithHTML(`❌ Post não encontrado. Use /gerar para criar um novo.`);
  }

  const updatedPost = parseEditedText(pending.post, editedText);
  pendingApprovals.set(postId, { ...pending, post: updatedPost });

  const preview = formatPostPreview(updatedPost);

  await ctx.replyWithHTML(
    `✏️ <b>Post editado:</b>\n\n${preview}`,
    { reply_markup: approveOnlyKeyboard(postId) }
  );
}

async function handleCopilotEditReply(ctx, editedText, editState) {
  const { copilotId } = editState;
  const pending = copilotPendingApprovals.get(copilotId);

  if (!pending) {
    return ctx.replyWithHTML(`❌ Sugestão não encontrada.`);
  }

  const trimmed = editedText.trim().substring(0, 200);
  pending.suggestedReply = trimmed;
  const newIntentUrl = buildIntentUrl(pending.tweetId, trimmed);
  const newQuoteIntentUrl = buildQuoteIntentUrl(pending.tweetId, pending.authorUsername, pending.quoteText);

  await bot.telegram.editMessageText(
    OWNER_CHAT_ID,
    pending.messageId,
    null,
    buildSuggestionMessage(pending.tweetText, pending.tweetUrl, pending.metrics, trimmed, true),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: copilotKeyboard(copilotId, newIntentUrl, newQuoteIntentUrl),
    }
  ).catch(() => {});

  ctx.replyWithHTML(`✅ Resposta atualizada.`);
}

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launch() {
  startCopilot(bot.telegram);
  await bot.launch();
}

module.exports = { bot, launch, sendForApproval, pendingApprovals };
