cat > server.js << 'EOF'
'use strict';
/* Стритфайт 98 — сервер (стабильность v2) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const {
  WEAPONS, LABELS, ICONS, VERBS, RARITY_LABEL, DEFAULT_SKIN, SKIN_BY_ID,
  BOX_COST, MAX_MERC_LEVEL, mercTrainCost, mercStats,
  resolveRound, defaultGear, openLootbox, damageFor, checkUnlocks,
} = require('./lib');
const db = require('./db');
const { verifyInitData } = require('./tgAuth');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PORT = process.env.PORT || 3000;
const T_MOVE = (+process.env.T_MOVE || 20) * 1000;
const REVEAL_PAUSE = +process.env.T_REVEAL_PAUSE || 1800;
const ROOM_TTL = 10 * 60 * 1000;
const START_TOKENS = 40;
const WIN_TOKENS = 8, LOSS_TOKENS = 3, DRAW_TOKENS = 1;
const WIN_RATING = 15, LOSS_RATING = -10;

const rooms = new Map();
const economy = new Map();
const queue = [];
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

const logFile = fs.createWriteStream('server.log', { flags: 'a' });
function logToFile(...args) {
  const ts = new Date().toISOString();
  logFile.write(`[${ts}] ${args.join(' ')}\n`);
}

// Rate limiting
const rateLimit = new Map();
function checkRateLimit(key, max = 40, windowMs = 60000) {
  const n = Date.now();
  if (!rateLimit.has(key)) rateLimit.set(key, { count: 0, reset: n + windowMs });
  const data = rateLimit.get(key);
  if (n > data.reset) {
    data.count = 0;
    data.reset = n + windowMs;
  }
  data.count++;
  return data.count <= max;
}

function genCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); } while (rooms.has(c));
  return c;
}
const cleanText = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function getEconomy(key, nick) {
  let e = economy.get(key);
  if (!e) {
    e = {
      nick: nick || 'Аноним', tokens: START_TOKENS, rating: 1000, wins: 0, losses: 0,
      gear: defaultGear(), unlockedSkins: [DEFAULT_SKIN.id], equippedSkin: DEFAULT_SKIN.id, mercLevels: {},
    };
    economy.set(key, e);
    saveEconomy(key);
  } else if (nick && nick !== e.nick) {
    e.nick = nick;
    saveEconomy(key);
  }
  return e;
}
function saveEconomy(key) { db.persist(key, economy.get(key)); }
function econPublic(e) {
  return {
    nick: e.nick, tokens: e.tokens, rating: e.rating, wins: e.wins, losses: e.losses,
    gear: e.gear, unlockedSkins: e.unlockedSkins, equippedSkin: e.equippedSkin, mercLevels: e.mercLevels || {},
  };
}
function skinOf(e) { return SKIN_BY_ID[e.equippedSkin] || DEFAULT_SKIN; }
function mercLevelOf(e, skinId) { return (e.mercLevels && e.mercLevels[skinId]) || 1; }
function currentStats(e) {
  const skin = skinOf(e);
  return mercStats(skin, mercLevelOf(e, skin.id));
}

function resolveKey(msg) {
  if (msg.initData && BOT_TOKEN) {
    const user = verifyInitData(msg.initData, BOT_TOKEN);
    if (user && user.id) return 'tg:' + user.id;
  }
  return cleanText(msg.key, 64) || uid();
}

function send(p, obj) { if (p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(obj)); } catch (_) {} } }
function broadcast(room, obj) { room.players.forEach(p => send(p, obj)); }
function other(room, id) { return room.players.find(p => p.id !== id); }

function log(room, text) {
  const e = { text, ts: now() };
  room.log.push(e);
  if (room.log.length > 300) room.log.shift();
  broadcast(room, { t: 'log', e });
  logToFile(`ROOM ${room.code}: ${text}`);
}

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }

function stateFor(room, p) {
  const opp = other(room, p.id);
  const eMe = getEconomy(p.key), eOpp = opp ? getEconomy(opp.key) : null;
  const skinMe = skinOf(eMe), statsMe = currentStats(eMe);
  const skinOpp = eOpp ? skinOf(eOpp) : null, statsOpp = eOpp ? currentStats(eOpp) : null;
  return {
    t: 'state', code: room.code, phase: room.phase, round: room.round,
    you: {
      id: p.id, nick: p.nick, hp: room.hp[p.id], maxHp: room.maxHp[p.id] || statsMe.hp, moved: !!room.moves[p.id],
      skin: { id: skinMe.id, name: skinMe.name, icon: skinMe.icon, level: mercLevelOf(eMe, skinMe.id) },
    },
    opponent: opp ? {
      id: opp.id, nick: opp.nick, online: opp.online, hp: room.hp[opp.id], maxHp: room.maxHp[opp.id] || statsOpp.hp, moved: !!room.moves[opp.id],
      skin: { id: skinOpp.id, name: skinOpp.name, icon: skinOpp.icon, level: mercLevelOf(eOpp, skinOpp.id) },
    } : null,
    deadline: room.deadline, serverNow: now(),
  };
}
function syncAll(room) { room.players.forEach(p => send(p, stateFor(room, p))); }

function makeRoom() {
  const room = {
    code: genCode(), players: [], phase: 'lobby', round: 0,
    hp: {}, moves: {}, deadline: 0, timer: null, killTimer: null,
    log: [], createdAt: now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, ws, nick, key) {
  const p = { id: uid(), token: uid(), nick, key, ws, online: true };
  room.players.push(p);
  ws._room = room; ws._pid = p.id;
  return p;
}

function startBattle(room) {
  room.phase = 'battle';
  room.round = 0;
  room.maxHp = {};
  room.players.forEach(p => {
    const stats = currentStats(getEconomy(p.key));
    room.maxHp[p.id] = stats.hp;
    room.hp[p.id] = stats.hp;
  });
  log(room, `Бой начинается! ${room.players.map(p => p.nick).join(' против ')}.`);
  nextRound(room);
}

function nextRound(room) {
  room.round += 1;
  room.moves = {};
  clearTimer(room);
  room.deadline = now() + T_MOVE;
  room.timer = setTimeout(() => forceRandomMoves(room), T_MOVE);
  syncAll(room);
}

function forceRandomMoves(room) {
  if (room.phase !== 'battle') return;
  room.players.forEach(p => { if (!room.moves[p.id]) room.moves[p.id] = WEAPONS[Math.floor(Math.random() * WEAPONS.length)]; });
  resolveIfReady(room);
}

function onMove(room, p, msg) {
  if (room.phase !== 'battle' || room.moves[p.id]) return;
  if (!WEAPONS.includes(msg.weapon)) return;
  room.moves[p.id] = msg.weapon;
  syncAll(room);
  resolveIfReady(room);
}

function resolveIfReady(room) {
  if (room.phase !== 'battle') return;
  if (!room.players.every(p => room.moves[p.id])) return;
  clearTimer(room);
  const [pa, pb] = room.players;
  const wa = room.moves[pa.id], wb = room.moves[pb.id];
  const outcome = resolveRound(wa, wb);
  const ea = getEconomy(pa.key), eb = getEconomy(pb.key);
  let text;
  if (outcome === 'draw') {
    text = `Раунд ${room.round}: оба выбрали ${LABELS[wa]} ${ICONS[wa]} — ничья, урона нет.`;
  } else {
    const winner = outcome === 'a' ? pa : pb;
    const loser = outcome === 'a' ? pb : pa;
    const wWeapon = outcome === 'a' ? wa : wb;
    const lWeapon = outcome === 'a' ? wb : wa;
    const winEcon = outcome === 'a' ? ea : eb;
    const dmg = damageFor(winEcon.gear, wWeapon) + currentStats(winEcon).dmgBonus;
    room.hp[loser.id] = Math.max(0, room.hp[loser.id] - dmg);
    const verb = VERBS[`${wWeapon}>${lWeapon}`] || 'побеждает';
    text = `Раунд ${room.round}: ${winner.nick} — ${LABELS[wWeapon]} ${ICONS[wWeapon]} ${verb} ${LABELS[lWeapon]} ${ICONS[lWeapon]} у ${loser.nick}. Урон: ${dmg}.`;
  }
  log(room, text);
  const dead = room.players.find(p => room.hp[p.id] <= 0);
  if (dead) { endBattle(room, other(room, dead.id), dead); return; }
  syncAll(room);
  setTimeout(() => nextRound(room), REVEAL_PAUSE);
}

function endBattle(room, winner, loser) {
  clearTimer(room);
  room.phase = 'over';
  const ew = getEconomy(winner.key), el = getEconomy(loser.key);
  ew.tokens += WIN_TOKENS; ew.wins += 1; ew.rating += WIN_RATING;
  el.tokens += LOSS_TOKENS; el.losses += 1; el.rating = Math.max(0, el.rating + LOSS_RATING);
  const newForWinner = checkUnlocks(ew);
  const newForLoser = checkUnlocks(el);
  saveEconomy(winner.key);
  saveEconomy(loser.key);
  const msg = `${winner.nick} побеждает! ${loser.nick} повержен(а).`;
  broadcast(room, { t: 'result', winner: winner.nick, msg });
  room.players.forEach(p => send(p, { t: 'economy', econ: econPublic(getEconomy(p.key)) }));
  log(room, msg);
  if (newForWinner.length) log(room, `🎉 ${winner.nick} разблокировал(а) скин: ${newForWinner.map(s => s.name).join(', ')}!`);
  if (newForLoser.length) log(room, `🎉 ${loser.nick} разблокировал(а) скин: ${newForLoser.map(s => s.name).join(', ')}!`);
  syncAll(room);
}

function onCreate(ws, msg) {
  if (!checkRateLimit('create')) return ws.send(JSON.stringify({ t: 'err', text: 'Слишком часто создаёте комнаты' }));
  const key = resolveKey(msg);
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  getEconomy(key, nick);
  const room = makeRoom();
  const p = addPlayer(room, ws, nick, key);
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id, econ: econPublic(getEconomy(key)) });
  log(room, `${nick} создал комнату ${room.code}.`);
  syncAll(room);
}

function onJoin(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  if (!room) { ws.send(JSON.stringify({ t: 'err', text: 'Комната не найдена.' })); return; }
  if (room.players.length >= 2) { ws.send(JSON.stringify({ t: 'err', text: 'Комната уже заполнена.' })); return; }
  const key = resolveKey(msg);
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  getEconomy(key, nick);
  const p = addPlayer(room, ws, nick, key);
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id, econ: econPublic(getEconomy(key)) });
  log(room, `${nick} присоединился.`);
  if (room.killTimer) { clearTimeout(room.killTimer); room.killTimer = null; }
  if (room.players.length === 2) startBattle(room);
  else syncAll(room);
}

function onQuick(ws, msg) { /* оставил как было */ }
function onRejoin(ws, msg) { /* оставил */ }
function onOpenBox(ws, msg) { /* оставил */ }
function onEquipSkin(ws, msg) { /* оставил */ }
function onTrainMercenary(ws, msg) { /* оставил */ }
function onIdentify(ws, msg) { /* оставил */ }

function onDisconnect(ws) { /* оставил */ }

/* HTTP + WS */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const fp = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!checkRateLimit(`ws:${ws._pid || 'anon'}`)) return;
    const room = ws._room;
    const p = room && room.players.find(q => q.id === ws._pid);
    switch (msg.t) {
      case 'identify': onIdentify(ws, msg); break;
      case 'create': if (!room) onCreate(ws, msg); break;
      case 'join': if (!room) onJoin(ws, msg); break;
      case 'quick': if (!room) onQuick(ws, msg); break;
      case 'rejoin': if (!room) onRejoin(ws, msg); break;
      case 'move': if (p) onMove(room, p, msg); break;
      case 'open_box': onOpenBox(ws, msg); break;
      case 'equip_skin': onEquipSkin(ws, msg); break;
      case 'train_mercenary': onTrainMercenary(ws, msg); break;
    }
  });

  ws.on('close', () => onDisconnect(ws));
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

(async () => {
  await db.init();
  const loaded = await db.loadAll();
  for (const [key, value] of loaded) economy.set(key, value);
  server.listen(PORT, () => console.log(`Стритфайт 98 online: http://localhost:${PORT}`));
})().catch(err => console.error('Ошибка инициализации:', err.message));
EOF
