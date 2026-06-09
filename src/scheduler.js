'use strict';

const cron = require('node-cron');
const { generatePost, generateLinkedInVersion } = require('./ai');
const { gatherResearch } = require('./research');
const { publish, normalizeIds, tweetUrl } = require('./publisher');
const { publishPost: publishLinkedIn, linkedinPostUrl } = require('./linkedin');
const { getSetting, savePost } = require('./db');
const { formatPostPreview, postToStorableContent } = require('./utils');

const X_USERNAME = process.env.X_USERNAME || null;
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Horários de Brasília com suas cron expressions
const SCHEDULE = [
  { label: '8h',  cron: '0 8  * * *' },
  { label: '10h', cron: '0 10 * * *' },
  { label: '13h', cron: '0 13 * * *' },
  { label: '17h', cron: '0 17 * * *' },
  { label: '20h', cron: '0 20 * * *' },
];

/**
 * Inicia todos os cron jobs.
 *
 * @param {Function} sendForApproval  - função de bot.js para enviar post para aprovação
 * @param {Object}   telegram         - instância bot.telegram (API de baixo nível do Telegraf)
 */
function startScheduler(sendForApproval, telegram) {
  SCHEDULE.forEach(({ label, cron: expression }) => {
    cron.schedule(
      expression,
      () => runJob(label, sendForApproval, telegram),
      { timezone: 'America/Sao_Paulo' }
    );
    console.log(`[scheduler] Agendado: ${label} (${expression}) America/Sao_Paulo`);
  });
}

async function runJob(label, sendForApproval, telegram) {
  console.log(`[scheduler] Disparo: ${label} — ${new Date().toISOString()}`);

  try {
    const research = await gatherResearch();
    const post = await generatePost(null, research);
    const isAuto = (await getSetting('autonomous_mode')) === 'true';

    if (isAuto) {
      await runAutonomous(post, label, telegram);
    } else {
      await sendForApproval(post, 'cron');
      console.log(`[scheduler] Post enviado para aprovação (${label})`);
    }
  } catch (err) {
    console.error(`[scheduler] Erro no job ${label}:`, err);
    await notifyError(telegram, label, err);
  }
}

async function runAutonomous(post, label, telegram) {
  // Publica no X
  const result = await publish(post);
  const xIds = normalizeIds(result);
  console.log(`[scheduler] Post autônomo publicado no X (${label}): ${xIds[0]}`);

  // Publica no LinkedIn (opcional — falha não bloqueia)
  let linkedinPostId = null;
  if (process.env.LINKEDIN_ACCESS_TOKEN) {
    try {
      const liText = await generateLinkedInVersion(post);
      linkedinPostId = await publishLinkedIn(liText);
      console.log(`[scheduler] Post publicado no LinkedIn (${label}): ${linkedinPostId}`);
    } catch (err) {
      console.error(`[scheduler] LinkedIn falhou (X ok):`, err.message);
    }
  }

  await savePost({
    content: postToStorableContent(post),
    format: post.format,
    tweet_ids: xIds,
    source: 'cron',
    linkedin_post_id: linkedinPostId,
  });

  if (telegram && OWNER_CHAT_ID) {
    const preview = formatPostPreview(post);
    const xUrl = tweetUrl(xIds[0], X_USERNAME);

    const links = [`<a href="${xUrl}">Ver no X</a>`];
    if (linkedinPostId) {
      links.push(`<a href="${linkedinPostUrl(linkedinPostId)}">Ver no LinkedIn</a>`);
    }

    await telegram
      .sendMessage(
        OWNER_CHAT_ID,
        `🤖 <b>Post publicado automaticamente (${label})</b>\n\n${preview}\n\n${links.join(' · ')}`,
        { parse_mode: 'HTML', disable_web_page_preview: false }
      )
      .catch((e) => console.error('[scheduler] Erro ao notificar Telegram:', e.message));
  }
}

async function notifyError(telegram, label, err) {
  if (!telegram || !OWNER_CHAT_ID) return;
  await telegram
    .sendMessage(
      OWNER_CHAT_ID,
      `❌ <b>Erro no cron ${label}:</b> ${err.message}`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});
}

module.exports = { startScheduler };
