'use strict';
/* ИИ-соперник. Задача — чтобы живой игрок не отличил его от человека:
 * обычный ник, правдоподобный профиль (наёмник/снаряжение по «уровню»),
 * ходы с человеческими задержками и неидеальной стратегией.
 *
 * Важно: бот НЕ читерит — он не видит ход соперника заранее. Он выбирает
 * оружие по эвристике на основе своей истории (что игрок кидал раньше),
 * ровно как это делал бы человек, а не по подсмотренному ответу.
 */
const { WEAPONS, BEATS } = require('./lib');

// Правдоподобные ники — вперемешку стили, чтобы не читались как список.
const NICKS = [
  'kotik2000', 'Дарья', 'xX_Reaper_Xx', 'Миша', 'nova', 'Артём',
  'shadow', 'Лена', 'MAX_POWER', 'Соня', 'grimlock', 'Ваня',
  'pixelqueen', 'Костя', 'nightowl', 'Оля', 'zveroboy', 'Дима',
  'lucky777', 'Катя', 'phantom', 'Рома', 'sunflower', 'Игорь',
];

// Ники, которые бот уже занял в текущем запуске — чтобы не повторяться подряд.
let recentNicks = [];

function pickNick() {
  const pool = NICKS.filter(n => !recentNicks.includes(n));
  const choice = (pool.length ? pool : NICKS)[Math.floor(Math.random() * (pool.length ? pool.length : NICKS.length))];
  recentNicks.push(choice);
  if (recentNicks.length > 8) recentNicks.shift();
  return choice;
}

// Задержка «раздумья» перед ходом — логнормально-подобная: обычно 1.5–4.5 с,
// изредка дольше, как будто человек отвлёкся. Никогда не мгновенно.
// Границы настраиваются через env (для тестов можно сделать быстрыми).
const DELAY_MIN = +process.env.BOT_DELAY_MIN_MS || 1500;
const DELAY_SPREAD = +process.env.BOT_DELAY_SPREAD_MS || 3000;
function moveDelayMs() {
  const base = DELAY_MIN + Math.random() * DELAY_SPREAD;
  const occasionalPause = Math.random() < 0.15 ? Math.random() * 4000 : 0;
  return Math.round(base + occasionalPause);
}

// Выбор оружия. Эвристика с элементом случайности:
// - в ~35% случаев чистый рандом (человек тоже не всегда думает);
// - иначе пытается контрить самое частое оружие соперника за прошлые раунды;
// - если истории ещё нет — рандом.
// history — массив последних ходов соперника (строки из WEAPONS).
function chooseWeapon(history) {
  if (!history || history.length === 0 || Math.random() < 0.35) {
    return WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
  }
  // считаем частоту ходов соперника
  const freq = {};
  for (const w of history) freq[w] = (freq[w] || 0) + 1;
  let mostCommon = history[history.length - 1];
  let max = 0;
  for (const w of Object.keys(freq)) if (freq[w] > max) { max = freq[w]; mostCommon = w; }
  // выбираем оружие, которое бьёт самое частое оружие соперника
  const counters = WEAPONS.filter(w => BEATS[w] && BEATS[w].includes(mostCommon));
  if (counters.length === 0) return WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
  return counters[Math.floor(Math.random() * counters.length)];
}

// Профиль бота под «уровень» реального игрока, чтобы бой был честным и
// правдоподобным: у бота примерно сопоставимое снаряжение/рейтинг, а не
// всегда голый новичок и не всегда имба. Возвращает объект экономики,
// совместимый с sanitizeEconomy на сервере.
function makeBotEconomy(opponentEcon, defaultGear, DEFAULT_SKIN_ID) {
  const oppRating = (opponentEcon && opponentEcon.rating) || 1000;
  // рейтинг бота — вокруг рейтинга игрока с небольшим разбросом
  const rating = Math.max(0, Math.round(oppRating + (Math.random() * 120 - 60)));
  const gear = defaultGear();
  // немного проапгрейдим случайное оружие, если игрок сам не совсем новичок
  const oppMaxRarity = opponentEcon && opponentEcon.gear
    ? Object.values(opponentEcon.gear).some(r => r !== 'common') : false;
  if (oppMaxRarity && Math.random() < 0.6) {
    const w = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    gear[w] = Math.random() < 0.7 ? 'rare' : 'epic';
  }
  return {
    nick: pickNick(),
    tokens: 40,
    rating,
    wins: Math.floor(Math.random() * 20),
    losses: Math.floor(Math.random() * 20),
    gear,
    unlockedSkins: [DEFAULT_SKIN_ID],
    equippedSkin: DEFAULT_SKIN_ID,
    mercLevels: {},
  };
}

module.exports = { pickNick, moveDelayMs, chooseWeapon, makeBotEconomy };
