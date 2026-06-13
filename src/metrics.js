'use strict';

const cron = require('node-cron');
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const {
  getRecentPosts,
  saveMetrics,
  getMetricsSummary,
  getTopPerformerPosts,
  getWorstPerformerPosts,
  getSetting,
  saveProfileSnapshot,
  getLatestProfileSnapshot,
  getPreviousProfileSnapshot,
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

let _openai;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Coleta via userTimeline + perfil ────────────────────────────────────────

async function collectMetrics() {
  console.log('[metrics] Iniciando coleta de métricas...');

  // Busca dados do perfil (seguidores)
  const me = await rwClient.v2.me({ 'user.fields': 'public_metrics' });
  const userId = me.data.id;
  const followers = me.data?.public_metrics?.followers_count || 0;

  // Busca últimos 20 tweets do próprio timeline
  const timeline = await rwClient.v2.userTimeline(userId, {
    'tweet.fields': 'public_metrics,created_at',
    max_results: 20,
  });

  const tweets = timeline.data?.data || [];
  let impressionsTotal = 0;
  let likesTotal = 0;

  for (const tweet of tweets) {
    const m = tweet.public_metrics || {};
    impressionsTotal += m.impression_count || 0;
    likesTotal += m.like_count || 0;
  }

  // Salva snapshot do perfil
  await saveProfileSnapshot({ followers_count: followers, impressions_total: impressionsTotal, likes_total: likesTotal });
  console.log(`[metrics] Snapshot salvo: ${followers} seguidores · ${impressionsTotal} impressões · ${likesTotal} likes`);

  // Salva métricas individuais cruzando tweet_ids com posts
  const allPosts = await getRecentPosts(80);
  const tweetMap = new Map();
  for (const post of allPosts) {
    const ids = JSON.parse(post.tweet_ids || '[]');
    if (ids[0]) tweetMap.set(ids[0], post);
  }

  let saved = 0;
  for (const tweet of tweets) {
    const post = tweetMap.get(tweet.id);
    if (!post) continue;
    const m = tweet.public_metrics || {};
    await saveMetrics({
      post_id:     post.id,
      tweet_id:    tweet.id,
      impressions: m.impression_count || 0,
      likes:       m.like_count       || 0,
      replies:     m.reply_count      || 0,
      retweets:    m.retweet_count    || 0,
      quotes:      m.quote_count      || 0,
    });
    saved++;
  }

  console.log(`[metrics] ${saved}/${tweets.length} tweets cruzados com posts salvos.`);
}

// ─── Relatório com análise IA ─────────────────────────────────────────────────

async function generateReport(telegram) {
  console.log('[metrics] Gerando relatório...');

  await collectMetrics();

  const latest   = await getLatestProfileSnapshot();
  const previous = await getPreviousProfileSnapshot();
  const week     = await getMetricsSummary(7, 0);
  const top3     = await getTopPerformerPosts(3, 7);
  const worst3   = await getWorstPerformerPosts(3, 7);

  const followers     = latest?.followers_count   || 0;
  const prevFollowers = previous?.followers_count || 0;
  const followerDiff  = followers - prevFollowers;
  const diffStr       = followerDiff >= 0
    ? `+${followerDiff.toLocaleString('pt-BR')}`
    : followerDiff.toLocaleString('pt-BR');

  const goalRaw      = await getSetting('follower_goal');
  const followerGoal = parseInt(goalRaw || '1000', 10);
  const pctGoal      = followerGoal > 0 ? Math.round((followers / followerGoal) * 100) : 0;

  const thisImp   = week.total_impressions || 0;
  const thisLikes = week.total_likes       || 0;
  const thisPosts = week.total_posts       || 0;

  // Sugestões via IA
  let aiBlock = '';
  try {
    const topSummary = top3
      .map((p) => `"${p.content.substring(0, 80).replace(/\n/g, ' ')}…" (${p.impressions || 0} imp, ${p.likes || 0} likes)`)
      .join('; ') || 'nenhum post com métricas ainda';

    const aiResp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content:
          `Você é consultor de crescimento no X (Twitter). ` +
          `O perfil tem ${followers} seguidores (meta: ${followerGoal}). ` +
          `Nos últimos 7 dias: ${thisPosts} posts, ${thisImp} impressões, ${thisLikes} likes. ` +
          `Top posts: ${topSummary}. ` +
          `Dê exatamente 3 sugestões práticas e específicas (máx 30 palavras cada) para chegar à meta de ${followerGoal} seguidores. ` +
          `Numere de 1 a 3. Responda em português, direto ao ponto.`,
      }],
      max_tokens: 300,
      temperature: 0.7,
    });

    const suggestions = (aiResp.choices[0]?.message?.content || '').trim();
    if (suggestions) aiBlock = `\n\n💡 <b>Sugestões da IA:</b>\n${escHtml(suggestions)}`;
  } catch (err) {
    console.error('[metrics] Erro na análise IA:', err.message);
  }

  let msg =
    `📊 <b>Relatório de métricas — X</b>\n\n` +
    `👥 Seguidores: <b>${followers.toLocaleString('pt-BR')}</b> (${diffStr} desde último relatório)\n` +
    `🎯 Meta: <b>${followerGoal.toLocaleString('pt-BR')}</b> seguidores — <b>${pctGoal}%</b> concluído\n\n` +
    `👁 Impressões (7d): <b>${thisImp.toLocaleString('pt-BR')}</b>\n` +
    `❤️ Likes (7d): <b>${thisLikes.toLocaleString('pt-BR')}</b>\n` +
    `📝 Posts (7d): <b>${thisPosts}</b>`;

  if (top3.length > 0) {
    msg += `\n\n🏆 <b>Top ${top3.length} posts (7d):</b>\n`;
    top3.forEach((p, i) => {
      const snippet = escHtml(p.content.substring(0, 70).replace(/\n/g, ' '));
      msg += `${i + 1}. ${(p.impressions || 0).toLocaleString('pt-BR')} imp · ${p.likes || 0}❤️\n<i>${snippet}…</i>\n`;
    });
  }

  if (worst3.length > 0) {
    msg += `\n📉 <b>Piores ${worst3.length}:</b>\n`;
    worst3.forEach((p, i) => {
      const snippet = escHtml(p.content.substring(0, 70).replace(/\n/g, ' '));
      msg += `${i + 1}. ${(p.impressions || 0).toLocaleString('pt-BR')} imp · ${p.likes || 0}❤️\n<i>${snippet}…</i>\n`;
    });
  }

  msg += aiBlock;

  if (telegram && OWNER_CHAT_ID) {
    await telegram
      .sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'HTML' })
      .catch((e) => console.error('[metrics] Erro ao enviar relatório:', e.message));
  }

  console.log('[metrics] Relatório enviado.');
  return msg;
}

// ─── Resumo on-demand (/metricas) ─────────────────────────────────────────────

async function getMetricsMessage() {
  const week = await getMetricsSummary(7, 0);
  const top3 = await getTopPerformerPosts(3, 7);

  const goalRaw      = await getSetting('follower_goal');
  const followerGoal = goalRaw ? parseInt(goalRaw, 10) : null;

  let msg =
    `📊 <b>Métricas — últimos 7 dias</b>\n\n` +
    `👁 Impressões: <b>${(week.total_impressions || 0).toLocaleString('pt-BR')}</b>\n` +
    `❤️ Likes: <b>${(week.total_likes || 0).toLocaleString('pt-BR')}</b>\n` +
    `📝 Posts: <b>${week.total_posts || 0}</b>\n`;

  if (followerGoal) {
    msg += `🎯 Meta de seguidores: <b>${followerGoal.toLocaleString('pt-BR')}</b>\n`;
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
  // Relatório terça e sexta às 22h
  cron.schedule(
    '0 22 * * 2,5',
    () => generateReport(telegram).catch((e) => console.error('[metrics] Erro relatório:', e.message)),
    { timezone: 'America/Sao_Paulo' }
  );

  console.log('[metrics] Agendado: relatório terça e sexta às 22h (America/Sao_Paulo)');
}

module.exports = {
  startMetrics,
  collectMetrics,
  getMetricsMessage,
  getLearningContext,
  generateReport,
};
