'use strict';

const LINKEDIN_API = 'https://api.linkedin.com/v2';

let cachedPersonUrn = null;

// ─── Helpers internos ─────────────────────────────────────────────────────────

function getToken() {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) throw new Error('LINKEDIN_ACCESS_TOKEN não configurado');
  return token;
}

async function linkedinFetch(path, options = {}) {
  const token = getToken();
  const url = `${LINKEDIN_API}${path}`;

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
    throw new Error(`LinkedIn API ${path} → ${res.status}: ${body.substring(0, 200)}`);
  }

  return res;
}

// ─── Person URN ───────────────────────────────────────────────────────────────

/**
 * Retorna o URN do usuário autenticado.
 * Usa LINKEDIN_PERSON_URN se definido, senão busca via /v2/me.
 * Resultado é cacheado em memória.
 */
async function getPersonUrn() {
  if (process.env.LINKEDIN_PERSON_URN) {
    return process.env.LINKEDIN_PERSON_URN;
  }

  if (cachedPersonUrn) return cachedPersonUrn;

  const res = await linkedinFetch('/me');
  const data = await res.json();

  if (!data.id) throw new Error('LinkedIn /v2/me não retornou id');

  cachedPersonUrn = `urn:li:person:${data.id}`;
  console.log(`[linkedin] Person URN: ${cachedPersonUrn}`);
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

  const res = await linkedinFetch('/ugcPosts', {
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
