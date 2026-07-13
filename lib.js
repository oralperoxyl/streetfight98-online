'use strict';
// Классическое расширенное КНБ: каждый вариант бьёт ровно двух других и проигрывает ровно двум.
const WEAPONS = ['rock', 'paper', 'scissors', 'lizard', 'spock'];
const LABELS = { rock: 'Камень', paper: 'Бумага', scissors: 'Ножницы', lizard: 'Ящерица', spock: 'Спок' };
const ICONS = { rock: '🪨', paper: '📄', scissors: '✂️', lizard: '🦎', spock: '🖖' };
const BEATS = {
  rock: ['scissors', 'lizard'],
  paper: ['rock', 'spock'],
  scissors: ['paper', 'lizard'],
  lizard: ['spock', 'paper'],
  spock: ['rock', 'scissors'],
};
const VERBS = {
  'rock>scissors': 'разбивает', 'rock>lizard': 'дробит',
  'paper>rock': 'заворачивает', 'paper>spock': 'опровергает',
  'scissors>paper': 'режет', 'scissors>lizard': 'обезглавливает',
  'lizard>spock': 'травит', 'lizard>paper': 'ест',
  'spock>rock': 'испаряет', 'spock>scissors': 'ломает',
};

const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const RARITY_WEIGHTS = { common: 60, rare: 25, epic: 12, legendary: 3 };
const RARITY_BONUS = { common: 0, rare: 3, epic: 6, legendary: 10 };
const RARITY_LABEL = { common: 'Обычное', rare: 'Редкое', epic: 'Эпическое', legendary: 'Легендарное' };
const BASE_DAMAGE = 10;
const MAX_HP = 100;
const BOX_COST = 20;
const SKIN_BOX_CHANCE = 0.2; // шанс, что лутбокс выдаст скин вместо оружия

const MAX_MERC_LEVEL = 5;
const TRAIN_BASE_COST = 5; // стоимость тренировки = TRAIN_BASE_COST * текущий уровень
const DEFAULT_SKIN = { id: 'rookie', name: 'Новичок', icon: '🙂', source: 'default', hpDelta: 0, dmgDelta: 0 };

// Гарантированные наёмники за прогресс — не зависят от удачи
const MILESTONE_SKINS = [
  { id: 'trainee', name: 'Панк-стажёр', icon: '🎤', source: 'milestone', wins: 3, hpDelta: 5, dmgDelta: 0 },
  { id: 'streetfighter', name: 'Уличный боец', icon: '🥊', source: 'milestone', wins: 10, hpDelta: 0, dmgDelta: 1 },
  { id: 'veteran', name: 'Ветеран квартала', icon: '🎸', source: 'milestone', wins: 25, hpDelta: 10, dmgDelta: 1 },
  { id: 'legend', name: 'Легенда двора', icon: '👑', source: 'milestone', wins: 50, hpDelta: 15, dmgDelta: 2 },
];
const RATING_SKINS = [
  { id: 'bronze', name: 'Бронзовый ранг', icon: '🥉', source: 'rating', rating: 1100, hpDelta: 5, dmgDelta: 0 },
  { id: 'silver', name: 'Серебряный ранг', icon: '🥈', source: 'rating', rating: 1250, hpDelta: 10, dmgDelta: 1 },
  { id: 'gold', name: 'Золотой ранг', icon: '🥇', source: 'rating', rating: 1400, hpDelta: 15, dmgDelta: 1 },
  { id: 'platinum', name: 'Платиновый ранг', icon: '💎', source: 'rating', rating: 1600, hpDelta: 20, dmgDelta: 2 },
];
// Эксклюзивные наёмники — получить можно только из лутбокса
const LOOTBOX_SKINS = [
  { id: 'biker', name: 'Байкер', icon: '🏍️', source: 'lootbox', rarity: 'rare', hpDelta: 10, dmgDelta: 1 },
  { id: 'dj', name: 'Диджей', icon: '🎧', source: 'lootbox', rarity: 'rare', hpDelta: 5, dmgDelta: 2 },
  { id: 'graffiti', name: 'Король граффити', icon: '🎨', source: 'lootbox', rarity: 'epic', hpDelta: 15, dmgDelta: 2 },
  { id: 'boombox', name: 'Бумбокс-бунтарь', icon: '📻', source: 'lootbox', rarity: 'epic', hpDelta: 20, dmgDelta: 1 },
  { id: 'neonpunk', name: 'Неоновый панк', icon: '⚡', source: 'lootbox', rarity: 'legendary', hpDelta: 20, dmgDelta: 3 },
];
const ALL_SKINS = [DEFAULT_SKIN, ...MILESTONE_SKINS, ...RATING_SKINS, ...LOOTBOX_SKINS];
const SKIN_BY_ID = Object.fromEntries(ALL_SKINS.map(s => [s.id, s]));
const SKIN_BOX_RARITY_WEIGHTS = { rare: 65, epic: 28, legendary: 7 };

// Стоимость тренировки с уровня level до level+1
function mercTrainCost(level) { return TRAIN_BASE_COST * level; }

// Итоговые статы наёмника с учётом уровня: +3 HP и +1 урон за каждый уровень сверх 1-го
function mercStats(skin, level) {
  const lvl = Math.max(1, level || 1);
  return {
    hp: MAX_HP + (skin.hpDelta || 0) + (lvl - 1) * 3,
    dmgBonus: (skin.dmgDelta || 0) + (lvl - 1) * 1,
  };
}

function resolveRound(a, b) {
  if (a === b) return 'draw';
  if (BEATS[a] && BEATS[a].includes(b)) return 'a';
  if (BEATS[b] && BEATS[b].includes(a)) return 'b';
  return 'draw';
}

function rollRarity() {
  const total = Object.values(RARITY_WEIGHTS).reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (const rarity of RARITIES) {
    r -= RARITY_WEIGHTS[rarity];
    if (r <= 0) return rarity;
  }
  return 'common';
}

function defaultGear() {
  const gear = {};
  WEAPONS.forEach(w => { gear[w] = 'common'; });
  return gear;
}

function rarityRank(r) { return RARITIES.indexOf(r); }

function damageFor(gear, weapon) {
  const rarity = (gear && gear[weapon]) || 'common';
  return BASE_DAMAGE + RARITY_BONUS[rarity];
}

function rollWeighted(weights) {
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (const key of Object.keys(weights)) {
    r -= weights[key];
    if (r <= 0) return key;
  }
  return Object.keys(weights)[0];
}

// Проверяет прогресс игрока и возвращает список новых скинов, которые он только что разблокировал (по победам и рейтингу).
function checkUnlocks(econ) {
  if (!econ.unlockedSkins) econ.unlockedSkins = [DEFAULT_SKIN.id];
  const unlocked = [];
  MILESTONE_SKINS.forEach(s => {
    if (econ.wins >= s.wins && !econ.unlockedSkins.includes(s.id)) { econ.unlockedSkins.push(s.id); unlocked.push(s); }
  });
  RATING_SKINS.forEach(s => {
    if (econ.rating >= s.rating && !econ.unlockedSkins.includes(s.id)) { econ.unlockedSkins.push(s.id); unlocked.push(s); }
  });
  return unlocked;
}

// Открытие лутбокса: с шансом SKIN_BOX_CHANCE выдаёт эксклюзивный скин вместо оружия.
function openLootbox(econ) {
  if (Math.random() < SKIN_BOX_CHANCE) {
    const rarity = rollWeighted(SKIN_BOX_RARITY_WEIGHTS);
    const pool = LOOTBOX_SKINS.filter(s => s.rarity === rarity);
    const skin = pool[Math.floor(Math.random() * pool.length)];
    const already = econ.unlockedSkins && econ.unlockedSkins.includes(skin.id);
    if (!already) { if (!econ.unlockedSkins) econ.unlockedSkins = [DEFAULT_SKIN.id]; econ.unlockedSkins.push(skin.id); }
    return { kind: 'skin', id: skin.id, name: skin.name, icon: skin.icon, rarity, duplicate: !!already };
  }
  const weapon = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
  const rarity = rollRarity();
  const current = econ.gear[weapon] || 'common';
  const upgraded = rarityRank(rarity) > rarityRank(current);
  if (upgraded) econ.gear[weapon] = rarity;
  return { kind: 'weapon', weapon, rarity, upgraded, current: econ.gear[weapon] };
}

module.exports = {
  WEAPONS, LABELS, ICONS, BEATS, VERBS,
  RARITIES, RARITY_WEIGHTS, RARITY_BONUS, RARITY_LABEL,
  BASE_DAMAGE, MAX_HP, BOX_COST,
  MAX_MERC_LEVEL, TRAIN_BASE_COST, mercTrainCost, mercStats,
  DEFAULT_SKIN, MILESTONE_SKINS, RATING_SKINS, LOOTBOX_SKINS, ALL_SKINS, SKIN_BY_ID,
  resolveRound, rollRarity, defaultGear, rarityRank, openLootbox, damageFor, checkUnlocks,
};
