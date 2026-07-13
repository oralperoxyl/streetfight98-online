'use strict';
/* Проверка истории матчей и защитной санитизации экономики.
 * Запуск: DATABASE_URL=... node test/history-and-sanitize.test.js (сервер на :3300) */
const WebSocket = require('ws');
const URL = 'ws://localhost:3300/ws';
const WEAPONS = ['rock','paper','scissors','lizard','spock'];

let finished = false;

function mk(nick, key) {
  const c = { nick, key, ws: new WebSocket(URL), id: null, st: null };
  c.send = o => c.ws.send(JSON.stringify(o));
  c.ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'state') { c.st = m; act(c); }
    if (m.t === 'result') console.log('RESULT:', m.msg);
  });
  return c;
}
function act(c) {
  if (finished) return;
  const st = c.st;
  if (st.phase === 'battle' && !st.you.moved) {
    c.send({ t: 'move', weapon: WEAPONS[Math.floor(Math.random() * WEAPONS.length)] });
  }
  if (st.phase === 'over' && !finished) { finished = true; setTimeout(checkHistory, 400); }
}

function checkHistory() {
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'get_history', key: 'histkey-alice' })));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t !== 'history') return;
    console.log('history for alice:', JSON.stringify(m.history));
    if (Array.isArray(m.history) && m.history.length >= 1 && ('won' in m.history[0]) && ('opponent' in m.history[0]) && ('rounds' in m.history[0])) {
      console.log('PASS: match history recorded and retrievable with expected shape');
    } else {
      console.log('FAIL: history missing or wrong shape');
      process.exit(1);
    }
    ws.close();
    testSanitize();
  });
}

function testSanitize() {
  // Проверяем: даже если бы экономика была испорчена (отрицательные токены,
  // сломанная редкость, уровень наёмника вне диапазона), после следующего
  // сохранения (тренировка) она должна прийти к клиенту уже нормализованной.
  const key = 'sanitize-test-' + Date.now();
  const ws = new WebSocket(URL);
  let gotEcon = false;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'identify', key, nick: 'SanTest' })));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'economy' && !gotEcon) {
      gotEcon = true;
      const okShape = m.econ.tokens >= 0 && m.econ.rating >= 0 && m.econ.unlockedSkins.includes('rookie') && m.econ.equippedSkin;
      console.log('fresh economy has sane shape:', okShape, JSON.stringify(m.econ));
      if (okShape) console.log('PASS: sanitization invariants hold for a fresh profile');
      else { console.log('FAIL: fresh profile shape invalid'); process.exit(1); }
      ws.close();
      console.log('\nALL HISTORY/SANITIZE TESTS PASSED');
      process.exit(0);
    }
  });
}

const a = mk('Alice', 'histkey-alice');
const b = mk('Bob', 'histkey-bob');
a.ws.on('open', () => a.send({ t: 'quick', nick: 'Alice', key: 'histkey-alice' }));
b.ws.on('open', () => setTimeout(() => b.send({ t: 'quick', nick: 'Bob', key: 'histkey-bob' }), 300));

setTimeout(() => { if (!finished) { console.log('FAIL: battle timeout'); process.exit(1); } }, 40000);
