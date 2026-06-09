'use strict';

const FORMAT_LABELS = {
  opinion: '💬 Opinião',
  question: '❓ Pergunta',
  thread: '🧵 Thread',
  poll: '📊 Enquete',
  metric: '📈 Métrica',
};

const POLL_LETTERS = ['🅐', '🅑', '🅒', '🅓'];

// Escapa caracteres HTML para uso seguro em mensagens Telegram (parse_mode: HTML)
function escHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formata um post para exibição como preview no Telegram.
 * Retorna string com HTML seguro.
 */
function formatPostPreview(post) {
  const label = FORMAT_LABELS[post.format] || post.format;
  let text = `<b>${escHtml(label)}</b>\n\n`;

  if (post.format === 'thread' && Array.isArray(post.tweets) && post.tweets.length > 0) {
    post.tweets.forEach((tweet, i) => {
      text += `<b>${i + 1}/</b> ${escHtml(tweet)}\n\n`;
    });
    const totalChars = post.tweets.reduce((a, t) => a + t.length, 0);
    text += `<i>${post.tweets.length} tweets · ${totalChars} chars</i>`;
  } else if (post.format === 'poll' && Array.isArray(post.poll_options) && post.poll_options.length > 0) {
    text += `${escHtml(post.content)}\n\n`;
    text += `<b>Opcoes:</b>\n`;
    post.poll_options.forEach((opt, i) => {
      text += `${POLL_LETTERS[i] || `${i + 1}.`} ${escHtml(opt)}\n`;
    });
    text += `\n<i>${post.content.length} chars</i>`;
  } else {
    text += escHtml(post.content || '');
    const len = (post.content || '').length;
    text += `\n\n<i>${len} chars</i>`;
  }

  return text;
}

/**
 * Calcula o próximo horário agendado em horário de Brasília.
 * Retorna string descritiva.
 */
function getNextScheduledPost() {
  const now = new Date();
  const brasiliaStr = now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
  const brasilia = new Date(brasiliaStr);
  const currentMinutes = brasilia.getHours() * 60 + brasilia.getMinutes();

  const scheduledHours = [8, 10, 13, 17, 20];
  const next = scheduledHours.find((h) => h * 60 > currentMinutes);

  if (next !== undefined) {
    return `Hoje às ${next}h (Brasília)`;
  }
  return `Amanhã às 8h (Brasília)`;
}

/**
 * Faz o parse de texto editado pelo usuário de volta para um objeto post.
 * Tenta detectar formato thread (1/ 2/ ...) e poll (pergunta + - opções).
 */
function parseEditedText(originalPost, editedText) {
  const post = { ...originalPost };
  const text = editedText.trim();

  if (post.format === 'thread') {
    // Detecta linhas no formato "1/ texto" ou "1. texto"
    const threadRegex = /^(\d+)[/.]\s*([\s\S]*?)(?=\n\d+[/.]|\s*$)/gm;
    const tweets = [];
    let match;
    while ((match = threadRegex.exec(text)) !== null) {
      const tweetText = match[2].trim();
      if (tweetText) tweets.push(tweetText);
    }

    if (tweets.length >= 2) {
      post.tweets = tweets;
      post.content = tweets[0];
    } else {
      // Degrada para opinião
      post.format = 'opinion';
      post.content = text;
      post.tweets = null;
    }
  } else if (post.format === 'poll') {
    // Detecta "pergunta\n- opção\n- opção"
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const options = [];
    let question = '';

    for (const line of lines) {
      if (line.startsWith('- ')) {
        options.push(line.slice(2).trim());
      } else if (!question) {
        question = line;
      }
    }

    if (options.length >= 2) {
      post.content = question || text;
      post.poll_options = options.slice(0, 4);
    } else {
      post.format = 'opinion';
      post.content = text;
      post.poll_options = null;
    }
  } else {
    post.content = text;
  }

  return post;
}

/**
 * Extrai conteúdo textual de um post para salvar no histórico.
 */
function postToStorableContent(post) {
  if (post.format === 'thread' && post.tweets?.length) {
    return post.tweets.join('\n---\n');
  }
  return post.content || '';
}

module.exports = {
  escHtml,
  formatPostPreview,
  getNextScheduledPost,
  parseEditedText,
  postToStorableContent,
  FORMAT_LABELS,
};
