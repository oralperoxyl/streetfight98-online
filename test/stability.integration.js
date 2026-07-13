'use strict';
/* Проверка rate limiting и heartbeat на реальном сервере.
 * Запуск: MSG_RATE_LIMIT=5 MSG_RATE_WINDOW_MS=2000 HEARTBEAT_MS=1000 node test/stability.integration.js
 * (сервер должен быть поднят с теми же env на порту :3300) */
const WebSocket = require('ws');
const URL = 'ws://localhost:3300/ws';

async function testRateLimit() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let sawRateLimitError = false;
    let identifyOks = 0;
    ws.on('open', () => {
      // шлём заведомо больше сообщений, чем разрешает лимит (identify — самое безобидное)
      for (let i = 0; i < 15; i++) ws.send(JSON.stringify({ t: 'identify', key: 'ratekey' + i, nick: 'X' }));
    });
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.t === 'economy') identifyOks++;
      if (m.t === 'err' && /Слишком много запросов/.test(m.text)) sawRateLimitError = true;
    });
    setTimeout(() => {
      ws.close();
      if (sawRateLimitError) console.log('PASS: превышение частоты сообщений отклоняется сервером (получено', identifyOks, 'успешных до отсечки)');
      else { console.log('FAIL: сервер не ограничил частоту сообщений'); return reject(new Error('no rate limit triggered')); }
      resolve();
    }, 1500);
    ws.on('error', reject);
  });
}

async function testHeartbeatDisconnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => {
      // Отключаем автоматический ответ на ping, эмулируя "зависший" клиент,
      // который не отвечает pong'ом — сервер должен сам оборвать соединение.
      ws._socket.removeAllListeners('data');
      ws.on('ping', () => { /* намеренно НЕ отвечаем pong */ });
    });
    let closed = false;
    ws.on('close', () => { closed = true; });
    setTimeout(() => {
      if (closed) console.log('PASS: сервер сам разорвал не отвечающее на heartbeat соединение');
      else { console.log('FAIL: соединение осталось открытым несмотря на отсутствие pong'); return reject(new Error('heartbeat did not trigger')); }
      resolve();
    }, 3000);
    ws.on('error', () => {}); // ожидаем обрыв, это не ошибка теста
  });
}

(async () => {
  await testRateLimit();
  await testHeartbeatDisconnect();
  console.log('\nALL STABILITY TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
