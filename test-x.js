require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');

const userClient = new TwitterApi(process.env.X_ACCESS_TOKEN);

async function test() {
  console.log('Testando autenticação OAuth 2.0...');
  console.log('clientId:', process.env.X_CLIENT_ID?.substring(0, 10) + '...');
  console.log('accessToken:', process.env.X_ACCESS_TOKEN?.substring(0, 10) + '...');

  try {
    const me = await userClient.v2.me();
    console.log('✅ OAuth 2.0 OK! Usuário:', me.data.username);
  } catch (e) {
    console.log('❌ Erro v2:', e.code, e.message);
    console.log('Data:', JSON.stringify(e.data, null, 2));
  }
}

test();
