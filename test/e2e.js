'use strict';
/* Автотест: быстрый матч, оба бота случайно выбирают оружие каждый раунд до победы.
 * Отдельно проверяет покупку лутбокса через economy. Запуск: node test/e2e.js (сервер на :3300) */
const WebSocket = require('ws');
const URL = 'ws://localhost:3300/ws';
const WEAPONS = ['rock','paper','scissors','lizard','spock'];

let finished = false;

function mk(nick, key) {
  const c = { nick, key, ws: new WebSocket(URL), id: null, st: null };
  c.send = o => c.ws.send(JSON.stringify(o));
  c.ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'joined') { c.id = m.id; }
    if (m.t === 'state') { c.st = m; act(c); }
    if (m.t === 'result') { console.log('RESULT:', m.winner, '|', m.msg); }
  });
  return c;
}

function act(c) {
  if (finished) return;
  const st = c.st;
  if (st.phase === 'battle' && !st.you.moved) {
    const w = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    c.send({ t: 'move', weapon: w });
  }
  if (st.phase === 'over' && !finished) {
    finished = true;
    console.log('PASS: battle reached "over" phase, a winner was determined');
    testLootbox();
  }
}

function testLootbox() {
  const key = 'testkey:' + Date.now();
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'identify', key, nick: 'BoxTester' })));
  let gotEconomy = false, tokensBefore = null;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'economy' && !gotEconomy) {
      gotEconomy = true;
      tokensBefore = m.econ.tokens;
      console.log('Economy before box: tokens=' + tokensBefore + ' equippedSkin=' + m.econ.equippedSkin + ' unlockedSkins=' + JSON.stringify(m.econ.unlockedSkins));
      if (!m.econ.unlockedSkins || !m.econ.unlockedSkins.includes('rookie')) { console.log('FAIL: rookie skin not present by default'); process.exit(1); }
      ws.send(JSON.stringify({ t: 'open_box', key }));
    } else if (m.t === 'lootbox') {
      const cost = m.kind === 'skin' && !m.upgraded ? 10 : 20; // дубликат скина возвращает половину
      const spent = tokensBefore - m.econ.tokens;
      console.log('Lootbox result:', m.kind, m.rarityLabel, m.label, '| upgraded:', m.upgraded, '| tokens spent:', spent);
      if (spent === 20 || spent === 10) console.log('PASS: lootbox charged a sane token amount (' + spent + ')');
      else { console.log('FAIL: unexpected tokens spent', spent); process.exit(1); }
      ws.send(JSON.stringify({ t: 'equip_skin', key, skinId: 'rookie' }));
    } else if (m.t === 'err') {
      console.log('FAIL: lootbox error:', m.text);
      process.exit(1);
    } else if (m.t === 'economy' && gotEconomy) {
      console.log('After equip_skin, equippedSkin=' + m.econ.equippedSkin);
      if (m.econ.equippedSkin === 'rookie') console.log('PASS: skin equip round-trip works');
      else console.log('FAIL: equip did not apply');
      testTraining();
    }
  });
}

function testTraining() {
  const key = 'trainkey:' + Date.now();
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'identify', key, nick: 'TrainTester' })));
  let tokensBefore = null, gotEcon = false;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.t === 'economy' && !gotEcon) {
      gotEcon = true;
      tokensBefore = m.econ.tokens;
      console.log('Training test — tokens before:', tokensBefore, '| rookie level:', (m.econ.mercLevels && m.econ.mercLevels.rookie) || 1);
      ws.send(JSON.stringify({ t: 'train_mercenary', key, skinId: 'rookie' }));
    } else if (m.t === 'train_result') {
      const spent = tokensBefore - m.econ.tokens;
      console.log('Train result: newLevel=' + m.newLevel + ' cost=' + m.cost + ' actualSpent=' + spent);
      if (m.newLevel === 2 && m.cost === 5 && spent === 5) console.log('PASS: training charged correct cost and leveled up');
      else console.log('FAIL: unexpected training result');
      process.exit(0);
    } else if (m.t === 'err') {
      console.log('FAIL: training error:', m.text);
      process.exit(1);
    }
  });
}

setTimeout(() => { if (!finished) { console.log('FAIL: timeout — battle did not finish'); process.exit(1); } }, 60000);

const a = mk('Alice', 'alicekey');
const b = mk('Bob', 'bobkey');
a.ws.on('open', () => a.send({ t: 'quick', nick: 'Alice', key: 'alicekey' }));
b.ws.on('open', () => setTimeout(() => b.send({ t: 'quick', nick: 'Bob', key: 'bobkey' }), 300));
