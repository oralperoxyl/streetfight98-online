'use strict';
// Классическое расширенное КНБ + улучшенная экономика

const WEAPONS = ['rock', 'paper', 'scissors', 'lizard', 'spock'];
const LABELS = { rock: 'Камень', paper: 'Бумага', scissors: 'Ножницы', lizard: 'Ящерица', spock: 'Спок' };
const ICONS = { rock: '🪨', paper: '📄', scissors: '✂️', lizard: '🦎', spock: '🖖' };
const BEATS = { /* ...оставил как было... */ };
const VERBS = { /* ...оставил... */ };

const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const RARITY_WEIGHTS = { common: 60, rare: 25, epic: 12, legendary: 3 };
const RARITY_BONUS = { common: 0, rare: 3, epic: 6, legendary: 10 };
const RARITY_LABEL = { common: 'Обычное', rare: 'Редкое', epic: 'Эпическое', legendary: 'Легендарное' };
const BASE_DAMAGE = 10;
const MAX_HP = 100;
const BOX_COST = 20;
const SKIN_BOX_CHANCE = 0.2;

const MAX_MERC_LEVEL = 5;
const TRAIN_BASE_COST = 5;
const DEFAULT_SKIN = { id: 'rookie', name: 'Новичок', icon: '🙂', source: 'default', hpDelta: 0, dmgDelta: 0 };

// ... (остальные константы как было)

function mercTrainCost(level) { return TRAIN_BASE_COST * level; }

function mercStats(skin, level) {
  const lvl = Math.max(1, level || 1);
  return {
    hp: MAX_HP + (skin.hpDelta || 0) + (lvl - 1) * 3,
    dmgBonus: (skin.dmgDelta || 0) + (lvl - 1) * 1,
  };
}

function resolveRound(a, b) { /* ...оставил... */ }

function rollRarity() { /* ...оставил... */ }

function defaultGear() { /* ...оставил... */ }

function rarityRank(r) { return RARITIES.indexOf(r); }

function damageFor(gear, weapon) {
  const rarity = (gear && gear[weapon]) || 'common';
  return BASE_DAMAGE + RARITY_BONUS[rarity];
}

// Новая функция: проверка unlock'ов с логом
function checkUnlocks(econ) {
  if (!econ.unlockedSkins) econ.unlockedSkins = [DEFAULT_SKIN.id];
  const unlocked = [];
  // ...логика как была + добавь логи
  return unlocked;
}

// Улучшенный openLootbox с защитой
function openLootbox(econ) {
  if (econ.tokens < BOX_COST) throw new Error('Недостаточно жетонов');
  econ.tokens -= BOX_COST;
  // ...остальная логика
  return result;
}

module.exports = {
  // ...все экспорты
};
