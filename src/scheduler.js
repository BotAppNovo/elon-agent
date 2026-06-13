'use strict';

const cron = require('node-cron');
const { generatePost } = require('./ai');
const { gatherResearch } = require('./research');
const { publish, normalizeIds, tweetUrl } = require('./publisher');
const { getSetting, savePost } = require('./db');
const { formatPostPreview, postToStorableContent } = require('./utils');

const X_USERNAME = process.env.X_USERNAME || null;
const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Horários X — 2x por dia (Brasília)
const SCHEDULE = [
  { label: '8h',  cron: '0 8  * * *' },
  { label: '20h', cron: '0 20 * * *' },
];

/**
 * Inicia todos os cron jobs.
 *
 * @param {Function} sendForApproval  - função de bot.js para enviar post para aprovação
 * @param {Object}   telegram         - instância bot.telegram (API de baixo nível do Telegraf)
 */
function startScheduler(sendForApproval, telegram) {
  // X — 2 posts por dia
  SCHEDULE.forEach(({ label, cron: expression }) => {
    cron.schedule(
      expression,
      () => runJob(label, sendForApproval, telegram),
      { timezone: 'America/Sao_Paulo' }
    );
    console.log(`[scheduler] Agendado X: ${label} (${expression}) America/Sao_Paulo`);
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

  await savePost({
    content: postToStorableContent(post),
    format: post.format,
    tweet_ids: xIds,
    source: 'cron',
    linkedin_post_id: null,
  });

  if (telegram && OWNER_CHAT_ID) {
    const preview = formatPostPreview(post);
    const xUrl = tweetUrl(xIds[0], X_USERNAME);

    await telegram
      .sendMessage(
        OWNER_CHAT_ID,
        `🤖 <b>Post publicado automaticamente (${label})</b>\n\n${preview}\n\n<a href="${xUrl}">Ver no X</a>`,
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
