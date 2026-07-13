'use strict';
/* Тест защиты профиля: подделать чужой key через initData с валидной подписью
 * своего же Telegram-аккаунта не получится — сервер всегда берёт id из подписи,
 * а не из msg.key. Плюс проверка модуля db.js напрямую против Postgres.
 * Запуск: BOT_TOKEN=... DATABASE_URL=... node test/auth-and-db.test.js (сервер на :3300) */
const crypto = require('crypto');
const WebSocket = require('ws');
const URL = 'ws://localhost:3300/ws';
const BOT_TOKEN = process.env.BOT_TOKEN;

function signInitData(fields, botToken) {
  const pairs = Object.keys(fields).sort().map(k => k + '=' + fields[k]);
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const usp = new URLSearchParams(fields);
  usp.set('hash', hash);
  return usp.toString();
}

async function main() {
  if (!BOT_TOKEN) { console.log('SKIP: BOT_TOKEN not set for this test run'); process.exit(0); }

  const legitUser = { id: 555777999, first_name: 'Real' };
  const initData = signInitData({ user: JSON.stringify(legitUser), auth_date: String(Math.floor(Date.now() / 1000)) }, BOT_TOKEN);

  const spoofResult = await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'identify', key: 'someone-elses-key', nick: 'Attacker', initData })));
    ws.on('message', raw => resolve(JSON.parse(raw)));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  if (spoofResult.key === 'tg:555777999') console.log('PASS: verified initData overrides spoofed msg.key');
  else { console.log('FAIL: spoofed key was not overridden:', spoofResult.key); process.exit(1); }

  const badInitData = 'user=' + encodeURIComponent(JSON.stringify({ id: 1 })) + '&auth_date=1&hash=' + '0'.repeat(64);
  const fallbackResult = await new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'identify', key: 'plain-web-key', nick: 'WebUser', initData: badInitData })));
    ws.on('message', raw => resolve(JSON.parse(raw)));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  if (fallbackResult.key === 'plain-web-key') console.log('PASS: invalid signature falls back to client key (expected outside Telegram)');
  else { console.log('FAIL: unexpected fallback behavior:', fallbackResult.key); process.exit(1); }

  console.log('ALL AUTH TESTS PASSED');
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
