require('dotenv').config();

const http = require('http');
const { initDb } = require('./src/db');
const { bot, launch, sendForApproval } = require('./src/bot');
const { startScheduler } = require('./src/scheduler');

// Minimal HTTP server — satisfaz health check do Railway
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('elon agent running');
});

async function main() {
  console.log('[elon] Iniciando agente...');

  await initDb();
  console.log('[elon] Banco de dados OK');

  startScheduler(sendForApproval, bot.telegram);
  console.log('[elon] Scheduler OK — posts em: 8h, 10h, 13h, 17h, 20h (Brasilia)');

  server.listen(process.env.PORT || 3000, () => {
    console.log(`[elon] HTTP health check na porta ${process.env.PORT || 3000}`);
  });

  await launch();
  console.log('[elon] Bot Telegram ativo. Pronto.');
}

main().catch((err) => {
  console.error('[elon] Erro fatal na inicializacao:', err);
  process.exit(1);
});

process.once('SIGINT', () => {
  console.log('[elon] SIGINT recebido, encerrando...');
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  console.log('[elon] SIGTERM recebido, encerrando...');
  bot.stop('SIGTERM');
  server.close();
});
