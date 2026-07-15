'use strict';
/* Проверка профиля/статистики:
 *  - матч с ботом ПОПАДАЕТ в историю (иначе «Побед: 10» при пустой истории палит бота),
 *  - при этом ключ бота клиенту не утекает,
 *  - рейтинг считается по Эло (меняется не на плоские 15),
 *  - копятся стрик и статистика оружия,
 *  - в таблице лидеров нет ботов.
 * Запуск: DATABASE_URL=... BOT_FILL_MIN_SEC=1 node test/profile-stats.test.js (сервер на :3300) */
const WebSocket = require('ws');
const URL = 'ws://localhost:3300/ws';

const KEY = 'profile-test-' + Date.now();
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS: ' : 'FAIL: ') + name); if (!cond) fails++; };

function playBotMatch() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    let econBefore = null, econAfter = null, leak = false;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'quick', nick: 'Профиль', key: KEY })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (/"bot:|isBot/.test(raw.toString())) leak = true;
      if (m.t === 'joined' && m.econ) econBefore = m.econ;
      if (m.t === 'state' && m.phase === 'battle' && m.you && !m.you.moved) {
        ws.send(JSON.stringify({ t: 'move', weapon: 'rock' })); // всегда камень — проверим статистику оружия
      }
      if (m.t === 'economy' && econBefore) econAfter = m.econ;
      if (m.t === 'result') setTimeout(() => { ws.close(); resolve({ econBefore, econAfter, leak }); }, 400);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('таймаут матча')), 60000);
  });
}

function ask(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ t: type, key: KEY, ...extra })));
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.t !== 'economy') { ws.close(); resolve({ m, raw: raw.toString() }); } });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('таймаут ' + type)), 8000);
  });
}

(async () => {
  const { econBefore, econAfter, leak } = await playBotMatch();
  console.log('рейтинг до:', econBefore && econBefore.rating, '-> после:', econAfter && econAfter.rating);
  ok('признаки бота не утекли в трафик', !leak);
  ok('рейтинг изменился', econAfter && econAfter.rating !== econBefore.rating);
  ok('рейтинг изменился НЕ на плоские 15 (значит Эло)', econAfter && Math.abs(econAfter.rating - econBefore.rating) !== 15);
  ok('статистика оружия копится (камень)', econAfter && (econAfter.weaponUses || {}).rock > 0);
  ok('стрик посчитан', econAfter && typeof econAfter.streak === 'number');

  const h = await ask('get_history');
  const hist = h.m.history || [];
  console.log('история:', JSON.stringify(hist));
  ok('МАТЧ С БОТОМ ПОПАЛ В ИСТОРИЮ (стата сходится)', hist.length >= 1);
  ok('в истории нет ключа бота — только ник', !/bot:/.test(h.raw));

  const lb = await ask('get_leaderboard');
  const rows = lb.m.rows || [];
  console.log('топ:', JSON.stringify(rows));
  ok('таблица лидеров отвечает', Array.isArray(rows));
  ok('в топе нет ботов', !/bot:/.test(lb.raw) && rows.every(r => r.nick));
  ok('игрок виден в топе и помечен как "я"', rows.some(r => r.me));

  console.log(fails === 0 ? '\nPROFILE/STATS TESTS PASSED' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
