'use strict';

const { getSetting, saveSetting } = require('./db');

const LINKEDIN_API = 'https://api.linkedin.com/v2';
const DB_URN_KEY = 'linkedin_person_urn';

let cachedPersonUrn = null;

// ─── Helpers internos ─────────────────────────────────────────────────────────

function getToken() {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) throw new Error('LINKEDIN_ACCESS_TOKEN não configurado');
  return token;
}

async function linkedinFetch(url, options = {}) {
  const token = getToken();

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LinkedIn API ${url} → ${res.status}: ${body.substring(0, 200)}`);
  }

  return res;
}

// ─── Person URN ───────────────────────────────────────────────────────────────

/**
 * Retorna o URN do usuário autenticado.
 * Ordem de resolução:
 *   1. LINKEDIN_PERSON_URN (env)
 *   2. Cache em memória
 *   3. Cache no banco (linkedin_person_urn)
 *   4. /v2/userinfo  (OpenID Connect — mais confiável)
 *   5. /v2/me?projection=(id)  (fallback legado)
 * Resultado persistido no banco para evitar chamadas extras.
 */
async function getPersonUrn() {
  // 1. env var manual
  if (process.env.LINKEDIN_PERSON_URN) {
    return process.env.LINKEDIN_PERSON_URN;
  }

  // 2. cache em memória
  if (cachedPersonUrn) return cachedPersonUrn;

  // 3. cache no banco
  const stored = await getSetting(DB_URN_KEY);
  if (stored) {
    cachedPersonUrn = stored;
    return cachedPersonUrn;
  }

  // 4. tenta /userinfo (OpenID Connect)
  try {
    const res = await linkedinFetch('https://api.linkedin.com/v2/userinfo');
    const data = await res.json();
    if (data.sub) {
      cachedPersonUrn = `urn:li:person:${data.sub}`;
      await saveSetting(DB_URN_KEY, cachedPersonUrn);
      console.log(`[linkedin] Person URN via /userinfo: ${cachedPersonUrn}`);
      return cachedPersonUrn;
    }
  } catch (err) {
    console.warn('[linkedin] /userinfo falhou, tentando /me:', err.message);
  }

  // 5. fallback: /me?projection=(id)
  const res = await linkedinFetch(`${LINKEDIN_API}/me?projection=(id)`);
  const data = await res.json();
  if (!data.id) throw new Error('LinkedIn /v2/me não retornou id');

  cachedPersonUrn = `urn:li:person:${data.id}`;
  await saveSetting(DB_URN_KEY, cachedPersonUrn);
  console.log(`[linkedin] Person URN via /me: ${cachedPersonUrn}`);
  return cachedPersonUrn;
}

// ─── Publicação ───────────────────────────────────────────────────────────────

/**
 * Publica um texto no LinkedIn do usuário autenticado.
 * Retorna o URN do post criado (ex: "urn:li:ugcPost:123456789").
 */
async function publishPost(text) {
  const authorUrn = await getPersonUrn();

  const body = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await linkedinFetch(`${LINKEDIN_API}/ugcPosts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // LinkedIn retorna o URN do post no header X-RestLi-Id
  const postUrn =
    res.headers.get('x-restli-id') ||
    res.headers.get('X-RestLi-Id') ||
    (await res.json().catch(() => ({}))).id ||
    null;

  if (!postUrn) {
    console.warn('[linkedin] Post publicado mas URN não retornado pelo header');
    return null;
  }

  return postUrn; // ex: "urn:li:ugcPost:7234567890123456"
}

/**
 * Converte um URN de post LinkedIn em URL pública.
 */
function linkedinPostUrl(postUrn) {
  if (!postUrn) return null;
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/`;
}

module.exports = { publishPost, linkedinPostUrl };
