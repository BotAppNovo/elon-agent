'use strict';

const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const {
  getRecentPosts,
  saveMetrics,
  getMetricsSummary,
  getTopPerformerPosts,
  getWorstPerformerPosts,
  getSetting,
} = require('./db');
const { escHtml } = require('./utils');

const _client = new TwitterApi({
  appKey:       process.env.X_CLIENT_ID,
  appSecret:    process.env.X_CLIENT_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});
const rwClient = _client.readWrite;

const OWNER_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Coleta diária ────────────────────────────────────────────────────────────

async function collectMetrics() {
  console.log('[metrics] Iniciando coleta diária de métricas...');

  const allPosts = await getRecentPosts(80);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekPosts = allPosts.filter((p) => new Date(p.published_at).getTime() >= cutoff);

  if (weekPosts.length === 0) {
    console.log('[metrics] Nenhum post nos últimos 7 dias para coletar.');
    return;
  }

  let collected = 0;
  for (const post of weekPosts) {
    try {
      const tweetIds = JSON.parse(post.tweet_ids || '[]');
      if (!tweetIds.length) continue;

      const tweetId = tweetIds[0]; // âncora (primeiro tweet da thread)

      const response = await rwClient.v2.singleTweet(tweetId, {
        'tweet.fields': 'public_metrics,non_public_metrics',
      });

      const pub    = response.data?.public_metrics    || {};
      const nonPub = response.data?.non_public_metrics || {};

      await saveMetrics({
        post_id:     post.id,
        tweet_id:    tweetId,
        impressions: nonPub.impression_count || 0,
        likes:       pub.like_count          || 0,
        replies:     pub.reply_count         || 0,
        retweets:    pub.retweet_count       || 0,
        quotes:      pub.quote_count         || 0,
      });

      collected++;
    } catch (err) {
      console.error(`[metrics] Erro ao coletar post ${post.id}:`, err.message);
    }
  }

  console.log(`[metrics] ${collected}/${weekPosts.length} posts coletados.`);
}

// ─── Relatório semanal (domingo 20h) ─────────────────────────────────────────

async function weeklyReport(telegram) {
  console.log('[metrics] Gerando relatório semanal...');

  const thisWeek = await getMetricsSummary(7, 0);
  const prevWeek = await getMetricsSummary(14, 7);
  const top3     = await getTopPerformerPosts(3, 7);
  const worst3   = await getWorstPerformerPosts(3, 7);

  // Seguidores atuais via API
  let followersStr = '—';
  try {
    const me = await rwClient.v2.me({ 'user.fields': 'public_metrics' });
    const n = me.data?.public_metrics?.followers_count;
    if (typeof n === 'number') followersStr = n.toLocaleString('pt-BR');
  } catch (err) {
    console.error('[metrics] Erro ao buscar seguidores:', err.message);
  }

  const thisImp    = thisWeek.total_impressions || 0;
  const prevImp    = prevWeek.total_impressions || 0;
  const impDiff    = thisImp - prevImp;
  const impDiffStr = impDiff >= 0
    ? `+${impDiff.toLocaleString('pt-BR')}`
    : impDiff.toLocaleString('pt-BR');

  // Progresso da meta
  let goalLine = '';
  const goalRaw = await getSetting('metric_goal');
  if (goalRaw) {
    try {
      const goal = JSON.parse(goalRaw);
      const current = goal.type === 'seguidores'
        ? (parseInt(followersStr.replace(/\D/g, ''), 10) || 0)
        : thisImp;
      const pct = goal.value > 0 ? Math.round((current / goal.value) * 100) : 0;
      goalLine = `\n🎯 <b>Meta:</b> ${goal.value.toLocaleString('pt-BR')} ${goal.type} — atual: ${current.toLocaleString('pt-BR')} (<b>${pct}%</b>)`;
    } catch {}
  }

  let msg =
    `📊 <b>Relatório semanal — X</b>\n\n` +
    `👁 Impressões: <b>${thisImp.toLocaleString('pt-BR')}</b> (<i>${impDiffStr} vs semana anterior</i>)\n` +
    `❤️ Likes: <b>${(thisWeek.total_likes || 0).toLocaleString('pt-BR')}</b>\n` +
    `📝 Posts publicados: <b>${thisWeek.total_posts || 0}</b>\n` +
    `👥 Seguidores: <b>${followersStr}</b>${goalLine}\n`;

  if (top3.length > 0) {
    msg += `\n🏆 <b>Top ${top3.length} da semana:</b>\n`;
    top3.forEach((p, i) => {
      const snippet = escHtml(p.content.substring(0, 70).replace(/\n/g, ' '));
      msg += `${i + 1}. [${p.format}] ${(p.impressions || 0).toLocaleString('pt-BR')} imp · ${p.likes || 0}❤️\n<i>${snippet}…</i>\n`;
    });
  }

  if (worst3.length > 0) {
    msg += `\n📉 <b>Piores ${worst3.length}:</b>\n`;
    worst3.forEach((p, i) => {
      const snippet = escHtml(p.content.substring(0, 70).replace(/\n/g, ' '));
      msg += `${i + 1}. [${p.format}] ${(p.impressions || 0).toLocaleString('pt-BR')} imp · ${p.likes || 0}❤️\n<i>${snippet}…</i>\n`;
    });
  }

  if (telegram && OWNER_CHAT_ID) {
    await telegram
      .sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'HTML' })
      .catch((e) => console.error('[metrics] Erro ao enviar relatório:', e.message));
  }

  console.log('[metrics] Relatório semanal enviado.');
}

// ─── Resumo on-demand (/metricas) ─────────────────────────────────────────────

async function getMetricsMessage() {
  const week = await getMetricsSummary(7, 0);
  const top3 = await getTopPerformerPosts(3, 7);

  let msg =
    `📊 <b>Métricas — últimos 7 dias</b>\n\n` +
    `👁 Impressões: <b>${(week.total_impressions || 0).toLocaleString('pt-BR')}</b>\n` +
    `❤️ Likes: <b>${(week.total_likes || 0).toLocaleString('pt-BR')}</b>\n` +
    `📝 Posts: <b>${week.total_posts || 0}</b>\n`;

  const goalRaw = await getSetting('metric_goal');
  if (goalRaw) {
    try {
      const goal = JSON.parse(goalRaw);
      const current = goal.type === 'impressoes' ? (week.total_impressions || 0) : null;
      msg += `🎯 <b>Meta:</b> ${goal.value.toLocaleString('pt-BR')} ${goal.type}`;
      if (typeof current === 'number') {
        const pct = goal.value > 0 ? Math.round((current / goal.value) * 100) : 0;
        msg += ` — atual: ${current.toLocaleString('pt-BR')} (<b>${pct}%</b>)`;
      }
      msg += '\n';
    } catch {}
  }

  if (top3.length > 0) {
    msg += `\n🏆 <b>Top ${top3.length} posts da semana:</b>\n`;
    top3.forEach((p, i) => {
      const snippet = escHtml(p.content.substring(0, 80).replace(/\n/g, ' '));
      msg += `${i + 1}. [${p.format}] ${(p.impressions || 0).toLocaleString('pt-BR')} imp · ${p.likes || 0}❤️\n<i>${snippet}…</i>\n`;
    });
  } else {
    msg += `\n<i>Nenhuma métrica coletada ainda. Use <code>/metricas coleta</code> para coletar agora.</i>`;
  }

  return msg;
}

// ─── Loop de aprendizado — injetado no prompt da IA ───────────────────────────

async function getLearningContext() {
  const top   = await getTopPerformerPosts(5, 14);
  const worst = await getWorstPerformerPosts(3, 14);
  return { top, worst };
}

// ─── Iniciar crons ────────────────────────────────────────────────────────────

function startMetrics(telegram) {
  cron.schedule(
    '0 23 * * *',
    () => collectMetrics().catch((e) => console.error('[metrics] Erro coleta diária:', e.message)),
    { timezone: 'America/Sao_Paulo' }
  );

  cron.schedule(
    '0 20 * * 0',
    () => weeklyReport(telegram).catch((e) => console.error('[metrics] Erro relatório semanal:', e.message)),
    { timezone: 'America/Sao_Paulo' }
  );

  console.log('[metrics] Agendado: coleta 23h diária · relatório domingo 20h (America/Sao_Paulo)');
}

module.exports = {
  startMetrics,
  collectMetrics,
  weeklyReport,
  getMetricsMessage,
  getLearningContext,
};
