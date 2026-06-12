'use strict';

const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const { saveApprovedTrend, clearExpiredTrends } = require('./db');

const BRAZIL_WOEID = 23424768;

const _client = new TwitterApi({
  appKey:       process.env.X_CLIENT_ID,
  appSecret:    process.env.X_CLIENT_SECRET,
  accessToken:  process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});
const rwClient = _client.readWrite;

let _openai;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ─── Busca de trends ──────────────────────────────────────────────────────────

async function fetchTrendNames() {
  // Tentativa 1: endpoint v2
  try {
    const resp = await rwClient.v2.get(`trends/by/woeid/${BRAZIL_WOEID}`);
    const names = (resp.data || []).map((t) => t.name).filter(Boolean);
    if (names.length > 0) {
      console.log(`[trends] v2: ${names.length} trends encontrados`);
      return names;
    }
  } catch (err) {
    console.log(`[trends] v2 indisponível no plano atual (${err.message}) — tentando v1.1`);
  }

  // Tentativa 2: endpoint v1.1
  try {
    const resp = await rwClient.v1.trendsByPlace(BRAZIL_WOEID);
    const names = (resp[0]?.trends || []).map((t) => t.name).filter(Boolean);
    console.log(`[trends] v1.1: ${names.length} trends encontrados`);
    return names;
  } catch (err) {
    console.error(`[trends] v1.1 também falhou:`, err.message);
    return [];
  }
}

// ─── Filtragem com IA ─────────────────────────────────────────────────────────

async function filterTrendsWithAI(trendNames) {
  if (trendNames.length === 0) return [];

  const trendList = trendNames.slice(0, 30).join(', ');
  console.log(`[trends] Enviando ${Math.min(trendNames.length, 30)} trends para filtragem`);

  let response;
  try {
    response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content:
            `Destes trending topics do Brasil, selecione até 2 que possam ser conectados com humor aos temas: ` +
            `esquecimento, sobrecarga mental, rotina caótica, procrastinação, vida adulta corrida. ` +
            `Eventos esportivos (jogos, Copa), memes de comportamento e zueiras do cotidiano geralmente funcionam. ` +
            `Política, tragédias, mortes e polêmicas sensíveis NUNCA. ` +
            `Responda em JSON puro (sem markdown): [{"trend": "nome", "angulo_sugerido": "como conectar ao tema"}]\n\n` +
            `Trends: ${trendList}`,
        },
      ],
      max_tokens: 300,
      temperature: 0.4,
    });
  } catch (err) {
    console.error('[trends] Erro na filtragem com IA:', err.message);
    return [];
  }

  const raw = (response.choices[0].message.content || '').trim();

  // Tentar parsear JSON direto
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((t) => t?.trend && typeof t.trend === 'string');
      console.log(`[trends] IA aprovou ${valid.length} trend(s):`, valid.map((t) => t.trend).join(', '));
      return valid;
    }
  } catch {
    // Tentar extrair JSON de possível markdown
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((t) => t?.trend && typeof t.trend === 'string');
          console.log(`[trends] IA aprovou ${valid.length} trend(s):`, valid.map((t) => t.trend).join(', '));
          return valid;
        }
      } catch {}
    }
  }

  console.warn('[trends] Resposta da IA não é JSON válido:', raw.substring(0, 200));
  return [];
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

async function fetchAndStoreTrends() {
  console.log('[trends] Buscando trending topics do Brasil...');

  await clearExpiredTrends();

  const trendNames = await fetchTrendNames();
  if (trendNames.length === 0) {
    console.log('[trends] Nenhum trend encontrado — finalizando.');
    return;
  }

  const approved = await filterTrendsWithAI(trendNames);
  if (approved.length === 0) {
    console.log('[trends] Nenhum trend aprovado pela IA — finalizando.');
    return;
  }

  for (const t of approved) {
    await saveApprovedTrend(t.trend, t.angulo_sugerido || null);
    console.log(`[trends] Salvo: "${t.trend}" — ângulo: ${t.angulo_sugerido || '—'}`);
  }

  console.log(`[trends] ${approved.length} trend(s) armazenado(s) com validade de 12h.`);
}

module.exports = { fetchAndStoreTrends };
