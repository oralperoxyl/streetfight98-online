'use strict';
/* Стритфайт 98 — сервер.
 * Экономика игрока (жетоны, снаряжение, рейтинг) хранится в памяти по playerKey
 * (id из Telegram либо сгенерированный и сохранённый в localStorage на клиенте).
 * Комната = машина состояний: lobby(2 игрока) → battle(раунды) → over.
 * Каждый раунд оба игрока выбирают оружие одновременно (сервер ждёт оба хода,
 * потом одновременно раскрывает — никто не видит выбор соперника заранее).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const {
  WEAPONS, LABELS, ICONS, VERBS, RARITY_LABEL, DEFAULT_SKIN, SKIN_BY_ID,
  BOX_COST, MAX_MERC_LEVEL, mercTrainCost, mercStats,
  resolveRound, defaultGear, openLootbox, damageFor, combinedDamage, checkUnlocks,
} = require('./lib');
const db = require('./db');
const { verifyInitData } = require('./tgAuth');
const logger = require('./logger');
const { createRateLimiter } = require('./rateLimit');
const BOT_TOKEN = process.env.BOT_TOKEN || '';

const PORT = process.env.PORT || 3000;
const T_MOVE = (+process.env.T_MOVE || 20) * 1000;
const REVEAL_PAUSE = +process.env.T_REVEAL_PAUSE || 1800;
const ROOM_TTL = 10 * 60 * 1000;
const START_TOKENS = 40;
const WIN_TOKENS = 8, LOSS_TOKENS = 3, DRAW_TOKENS = 1;
const WIN_RATING = 15, LOSS_RATING = -10;

// Rate limit на входящие WS-сообщения: 30 сообщений за 10 секунд с одного
// соединения — с запасом хватает на реальную игру (ходы, лутбоксы, чат),
// но режет флуд/скрипт-спам. HEARTBEAT_MS — как часто пингуем клиентов,
// чтобы вовремя заметить оборвавшееся соединение (не дожидаясь TCP-таймаута).
const MSG_RATE_LIMIT = +process.env.MSG_RATE_LIMIT || 30;
const MSG_RATE_WINDOW_MS = +process.env.MSG_RATE_WINDOW_MS || 10000;
const HEARTBEAT_MS = +process.env.HEARTBEAT_MS || 30000;
const wsRateLimiter = createRateLimiter(MSG_RATE_LIMIT, MSG_RATE_WINDOW_MS);

const rooms = new Map();
const economy = new Map(); // playerKey -> { nick, tokens, rating, wins, losses, gear }
const queue = [];
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

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
// Защитная нормализация: страхует экономику от порчи данных (NaN, отрицательные
// значения, неизвестная редкость, уровень наёмника вне диапазона, экипирован
// неразблокированный наёмник и т.п.) — неважно, откуда взялась бы порча, баг в
// коде, гонка состояний или ручное вмешательство в БД. Вызывается перед каждым
// сохранением, так что в Postgres и клиенту всегда уходят валидные данные.
function sanitizeEconomy(e) {
  const toNonNegInt = v => Math.max(0, Math.floor(Number(v) || 0));
  e.tokens = toNonNegInt(e.tokens);
  e.rating = toNonNegInt(e.rating);
  e.wins = toNonNegInt(e.wins);
  e.losses = toNonNegInt(e.losses);
  if (!e.gear || typeof e.gear !== 'object') e.gear = defaultGear();
  WEAPONS.forEach(w => { if (!RARITY_LABEL[e.gear[w]]) e.gear[w] = 'common'; });
  if (!Array.isArray(e.unlockedSkins) || !e.unlockedSkins.includes(DEFAULT_SKIN.id)) {
    e.unlockedSkins = Array.isArray(e.unlockedSkins) ? [...new Set([DEFAULT_SKIN.id, ...e.unlockedSkins])] : [DEFAULT_SKIN.id];
  }
  if (!e.equippedSkin || !e.unlockedSkins.includes(e.equippedSkin)) e.equippedSkin = DEFAULT_SKIN.id;
  if (!e.mercLevels || typeof e.mercLevels !== 'object') e.mercLevels = {};
  for (const id of Object.keys(e.mercLevels)) {
    const lvl = Math.floor(Number(e.mercLevels[id]) || 1);
    e.mercLevels[id] = Math.min(MAX_MERC_LEVEL, Math.max(1, lvl));
  }
  return e;
}
function saveEconomy(key) { db.persist(key, sanitizeEconomy(economy.get(key))); }
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

// Если клиент прислал initData из Telegram Mini App и она прошла проверку подписи —
// используем настоящий Telegram id, игнорируя то, что клиент прислал в msg.key.
// Это закрывает возможность подделать чужой профиль, отправив чужой id вручную.
// Без initData (обычный веб-фоллбэк) доверяем анонимному ключу из localStorage клиента.
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
  room.lastActivity = e.ts;
  if (room.log.length > 300) room.log.shift();
  broadcast(room, { t: 'log', e });
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
    log: [], createdAt: now(), lastActivity: now(),
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
  syncAll(room); // соперник видит "выбор сделан", но не сам выбор
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
  let resultPayload = { t: 'round_result', round: room.round, aId: pa.id, bId: pb.id, aWeapon: wa, bWeapon: wb, outcome, dmg: 0, loserId: null };
  if (outcome === 'draw') {
    text = `Раунд ${room.round}: оба выбрали ${LABELS[wa]} ${ICONS[wa]} — ничья, урона нет.`;
  } else {
    const winner = outcome === 'a' ? pa : pb;
    const loser = outcome === 'a' ? pb : pa;
    const wWeapon = outcome === 'a' ? wa : wb;
    const lWeapon = outcome === 'a' ? wb : wa;
    const winEcon = outcome === 'a' ? ea : eb;
    const dmg = combinedDamage(winEcon.gear, wWeapon, currentStats(winEcon).dmgBonus);
    room.hp[loser.id] = Math.max(0, room.hp[loser.id] - dmg);
    const verb = VERBS[`${wWeapon}>${lWeapon}`] || 'побеждает';
    text = `Раунд ${room.round}: ${winner.nick} — ${LABELS[wWeapon]} ${ICONS[wWeapon]} ${verb} ${LABELS[lWeapon]} ${ICONS[lWeapon]} у ${loser.nick}. Урон: ${dmg}.`;
    resultPayload.dmg = dmg;
    resultPayload.loserId = loser.id;
  }
  broadcast(room, resultPayload);
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
  db.recordMatch({ winnerKey: winner.key, winnerNick: winner.nick, loserKey: loser.key, loserNick: loser.nick, rounds: room.round });
  const msg = `${winner.nick} побеждает! ${loser.nick} повержен(а).`;
  broadcast(room, { t: 'result', winner: winner.nick, msg });
  room.players.forEach(p => send(p, { t: 'economy', econ: econPublic(getEconomy(p.key)) }));
  log(room, msg);
  if (newForWinner.length) log(room, `🎉 ${winner.nick} разблокировал(а) скин: ${newForWinner.map(s => s.name).join(', ')}!`);
  if (newForLoser.length) log(room, `🎉 ${loser.nick} разблокировал(а) скин: ${newForLoser.map(s => s.name).join(', ')}!`);
  syncAll(room);
}

/* ---------------- membership ---------------- */
function onCreate(ws, msg) {
  const key = resolveKey(msg);
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  getEconomy(key, nick);
  const room = makeRoom();
  const p = addPlayer(room, ws, nick, key);
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id, econ: econPublic(getEconomy(key)) });
  log(room, `${nick} создал комнату ${room.code}. Ждём соперника…`);
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

function onQuick(ws, msg) {
  const key = resolveKey(msg);
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  getEconomy(key, nick);
  if (queue.length > 0) {
    const waiting = queue.shift();
    if (waiting.ws.readyState !== 1) { onQuick(ws, msg); return; }
    const room = makeRoom();
    addPlayer(room, waiting.ws, waiting.nick, waiting.key);
    addPlayer(room, ws, nick, key);
    room.players.forEach(p => send(p, { t: 'joined', code: room.code, token: p.token, id: p.id, econ: econPublic(getEconomy(p.key)) }));
    log(room, `Быстрый бой: ${room.players[0].nick} против ${room.players[1].nick}!`);
    startBattle(room);
  } else {
    queue.push({ ws, nick, key });
    send({ ws }, { t: 'queued' });
  }
}

function onRejoin(ws, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  const p = room && room.players.find(q => q.token === msg.token);
  if (!p) { ws.send(JSON.stringify({ t: 'err', text: 'Сессия не найдена.', fatal: true })); return; }
  p.ws = ws; p.online = true;
  ws._room = room; ws._pid = p.id;
  send(p, { t: 'joined', code: room.code, token: p.token, id: p.id, econ: econPublic(getEconomy(p.key)) });
  if (room.killTimer) { clearTimeout(room.killTimer); room.killTimer = null; }
  log(room, `${p.nick} снова в сети.`);
  syncAll(room);
}

function onOpenBox(ws, msg) {
  const key = resolveKey(msg);
  if (!key) return;
  const e = getEconomy(key);
  if (e.tokens < BOX_COST) { ws.send(JSON.stringify({ t: 'err', text: `Нужно ${BOX_COST} жетонов, у вас ${e.tokens}.` })); return; }
  e.tokens -= BOX_COST;
  const result = openLootbox(e);
  if (result.kind === 'skin') {
    if (result.duplicate) e.tokens += Math.floor(BOX_COST / 2); // компенсация за дубликат
    saveEconomy(key);
    ws.send(JSON.stringify({
      t: 'lootbox', kind: 'skin', skinId: result.id, rarity: result.rarity, upgraded: !result.duplicate,
      label: result.name, icon: result.icon, rarityLabel: RARITY_LABEL[result.rarity],
      econ: econPublic(e),
    }));
  } else {
    saveEconomy(key);
    ws.send(JSON.stringify({
      t: 'lootbox', kind: 'weapon',
      weapon: result.weapon, rarity: result.rarity, upgraded: result.upgraded,
      label: LABELS[result.weapon], icon: ICONS[result.weapon], rarityLabel: RARITY_LABEL[result.rarity],
      econ: econPublic(e),
    }));
  }
}

function onEquipSkin(ws, msg) {
  const key = resolveKey(msg);
  if (!key) return;
  const e = getEconomy(key);
  const skinId = cleanText(msg.skinId, 32);
  if (!e.unlockedSkins.includes(skinId)) { ws.send(JSON.stringify({ t: 'err', text: 'Этот наёмник ещё не разблокирован.' })); return; }
  e.equippedSkin = skinId;
  saveEconomy(key);
  ws.send(JSON.stringify({ t: 'economy', econ: econPublic(e) }));
}

function onTrainMercenary(ws, msg) {
  const key = resolveKey(msg);
  if (!key) return;
  const e = getEconomy(key);
  const skinId = cleanText(msg.skinId, 32);
  if (!e.unlockedSkins.includes(skinId)) { ws.send(JSON.stringify({ t: 'err', text: 'Наёмник ещё не разблокирован.' })); return; }
  if (!e.mercLevels) e.mercLevels = {};
  const level = e.mercLevels[skinId] || 1;
  if (level >= MAX_MERC_LEVEL) { ws.send(JSON.stringify({ t: 'err', text: `Уже максимальный уровень (${MAX_MERC_LEVEL}).` })); return; }
  const cost = mercTrainCost(level);
  if (e.tokens < cost) { ws.send(JSON.stringify({ t: 'err', text: `Нужно ${cost} жетонов, у вас ${e.tokens}.` })); return; }
  e.tokens -= cost;
  e.mercLevels[skinId] = level + 1;
  saveEconomy(key);
  ws.send(JSON.stringify({ t: 'train_result', skinId, newLevel: level + 1, cost, econ: econPublic(e) }));
}

function onIdentify(ws, msg) {
  const key = resolveKey(msg);
  const nick = cleanText(msg.nick, 14) || 'Аноним';
  const e = getEconomy(key, nick);
  ws.send(JSON.stringify({ t: 'economy', key, econ: econPublic(e) }));
}

async function onGetHistory(ws, msg) {
  const key = resolveKey(msg);
  try {
    const history = await db.getHistory(key, 10);
    ws.send(JSON.stringify({ t: 'history', history }));
  } catch (err) {
    logger.error({ err: err.message }, 'Ошибка получения истории матчей');
    ws.send(JSON.stringify({ t: 'history', history: [] }));
  }
}

function onDisconnect(ws) {
  const qi = queue.findIndex(q => q.ws === ws);
  if (qi >= 0) queue.splice(qi, 1);
  const room = ws._room;
  if (!room) return;
  const p = room.players.find(q => q.id === ws._pid);
  if (!p || p.ws !== ws) return;
  p.online = false;
  log(room, `${p.nick} отключился.`);
  if (!room.players.some(q => q.online)) {
    room.killTimer = setTimeout(() => { clearTimer(room); rooms.delete(room.code); }, ROOM_TTL);
  }
  syncAll(room);
}

/* ---------------- wiring ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const HTTP_RATE_LIMIT = +process.env.HTTP_RATE_LIMIT || 120;
const HTTP_RATE_WINDOW_MS = +process.env.HTTP_RATE_WINDOW_MS || 60000;
const httpRateLimiter = createRateLimiter(HTTP_RATE_LIMIT, HTTP_RATE_WINDOW_MS);

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const ip = req.socket.remoteAddress || 'unknown';
  const rl = httpRateLimiter.check(ip);
  if (!rl.allowed) {
    logger.warn({ ip }, 'HTTP rate limit превышен');
    res.writeHead(429, { 'Retry-After': Math.ceil(rl.retryAfterMs / 1000) });
    res.end('too many requests');
    return;
  }
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
wss.on('connection', (ws, req) => {
  ws._rlKey = uid(); // ключ для rate-лимитера — свой на каждое соединение, ещё до identify
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  logger.info({ ip: req.socket.remoteAddress }, 'WS подключение открыто');

  ws.on('message', raw => {
    const rl = wsRateLimiter.check(ws._rlKey);
    if (!rl.allowed) {
      logger.warn({ rlKey: ws._rlKey }, 'Rate limit превышен — сообщение отброшено');
      ws.send(JSON.stringify({ t: 'err', text: 'Слишком много запросов, помедленнее.' }));
      return;
    }
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    const room = ws._room;
    const p = room && room.players.find(q => q.id === ws._pid);
    switch (msg.t) {
      case 'identify':  onIdentify(ws, msg); break;
      case 'create':    if (!room) onCreate(ws, msg); break;
      case 'join':      if (!room) onJoin(ws, msg); break;
      case 'quick':     if (!room) onQuick(ws, msg); break;
      case 'rejoin':    if (!room) onRejoin(ws, msg); break;
      case 'move':      if (p) onMove(room, p, msg); break;
      case 'open_box':  onOpenBox(ws, msg); break;
      case 'equip_skin':onEquipSkin(ws, msg); break;
      case 'train_mercenary': onTrainMercenary(ws, msg); break;
      case 'get_history': onGetHistory(ws, msg); break;
    }
  });
  ws.on('close', () => { wsRateLimiter.reset(ws._rlKey); onDisconnect(ws); });
  ws.on('error', err => logger.warn({ err: err.message }, 'WS ошибка соединения'));
});

// Heartbeat: пингуем все соединения раз в HEARTBEAT_MS. Если клиент не ответил
// pong'ом с прошлого пинга — считаем соединение мёртвым и рвём его сами, не
// дожидаясь TCP-таймаута (это может занимать минуты и держать комнату
// "как будто живой" всё это время). ws.terminate() запускает 'close' →
// onDisconnect(ws) выполнит обычную очистку.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { logger.info({ rlKey: ws._rlKey }, 'Heartbeat не отвечен — обрываем соединение'); return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

(async () => {
  await db.init();
  const loaded = await db.loadAll();
  for (const [key, value] of loaded) economy.set(key, value);
  if (!BOT_TOKEN) logger.warn('BOT_TOKEN не задан — проверка подписи Telegram отключена, профили доверяют клиенту.');
  server.listen(PORT, () => logger.info({ port: PORT, dbEnabled: db.isEnabled() }, 'Стритфайт 98 online'));
})().catch(err => {
  logger.error({ err }, 'Ошибка инициализации БД');
  server.listen(PORT, () => logger.info({ port: PORT, dbEnabled: false }, 'Стритфайт 98 online (без БД)'));
});

// Периодическая уборка: страховка поверх точечной TTL-очистки в onDisconnect —
// если по какой-то причине комната осталась без активного killTimer (баг,
// гонка состояний, ручное вмешательство), эта проверка рано или поздно её найдёт.
// Также чистит карту rate-лимитера от давно неактивных ключей.
const SWEEP_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let removedRooms = 0;
  for (const [code, room] of rooms.entries()) {
    const allOffline = room.players.every(p => !p.online);
    const stale = now - (room.lastActivity || room.createdAt) > ROOM_TTL;
    if (allOffline && stale) { clearTimer(room); rooms.delete(code); removedRooms++; }
  }
  wsRateLimiter.sweep();
  if (removedRooms > 0) logger.info({ removedRooms, activeRooms: rooms.size }, 'Плановая уборка комнат');
}, SWEEP_INTERVAL_MS);
