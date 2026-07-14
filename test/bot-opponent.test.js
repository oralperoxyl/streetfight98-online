'use strict';
/* Тест бота-соперника: один игрок заходит в быстрый бой, живого соперника нет,
 * через короткий таймаут подключается бот, матч идёт как обычный PvP до победы.
 * Проверяем, что с точки зрения клиента всё неотличимо от матча с человеком:
 * приходит joined -> state с соперником -> раунды -> result.
 * Запуск: BOT_FILL_MIN_SEC=1 BOT_FILL_MAX_SEC=2 node test/bot-opponent.test.js (сервер на :3300) */
const WebSocket = require('ws');
const URL = 'ws://localhost:3300/ws';
const WEAPONS = ['rock','paper','scissors','lizard','spock'];

let sawQueued = false, sawOpponent = false, sawRounds = 0, gotResult = false, oppNick = null;
let botLeakDetected = false;

const ws = new WebSocket(URL);
let myId = null;
ws.on('open', () => ws.send(JSON.stringify({ t: 'quick', nick: 'ЖивойИгрок', key: 'human-test-key' })));
ws.on('message', raw => {
  const m = JSON.parse(raw);

  // Любое сообщение не должно раскрывать, что соперник — бот
  const asText = JSON.stringify(m);
  if (/isBot|"bot:|makeBotEconomy/.test(asText)) botLeakDetected = true;

  if (m.t === 'queued') sawQueued = true;
  if (m.t === 'joined') myId = m.id;
  if (m.t === 'state') {
    if (m.opponent && m.opponent.nick) { sawOpponent = true; oppNick = m.opponent.nick; }
    // если наш ход — ходим
    if (m.phase === 'battle' && m.you && !m.you.moved) {
      ws.send(JSON.stringify({ t: 'move', weapon: WEAPONS[Math.floor(Math.random() * WEAPONS.length)] }));
    }
  }
  if (m.t === 'round_result') sawRounds++;
  if (m.t === 'result') {
    gotResult = true;
    setTimeout(() => {
      console.log('очередь -> queued:', sawQueued ? 'PASS' : 'FAIL');
      console.log('появился соперник (бот под ником "' + oppNick + '"):', sawOpponent ? 'PASS' : 'FAIL');
      console.log('сыграно раундов:', sawRounds, sawRounds > 0 ? 'PASS' : 'FAIL');
      console.log('матч завершился результатом:', gotResult ? 'PASS' : 'FAIL');
      console.log('в сообщениях клиенту НЕТ утечки признаков бота:', !botLeakDetected ? 'PASS' : 'FAIL — УТЕЧКА!');
      const allPass = sawQueued && sawOpponent && sawRounds > 0 && gotResult && !botLeakDetected;
      console.log(allPass ? '\nBOT OPPONENT TEST PASSED' : '\nBOT OPPONENT TEST FAILED');
      process.exit(allPass ? 0 : 1);
    }, 200);
  }
});
ws.on('error', e => { console.error('WS error:', e.message); process.exit(1); });

setTimeout(() => { console.log('FAIL: timeout — бот не подхватил матч или бой не завершился'); process.exit(1); }, 40000);
