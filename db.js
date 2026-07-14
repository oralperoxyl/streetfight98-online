'use strict';
/* Слой хранения профилей игроков в Postgres.
 * Храним экономику каждого игрока одной JSONB-колонкой — данные ещё активно
 * меняются формой (жетоны, снаряжение, наёмники, уровни), нормализовать рано.
 * Если DATABASE_URL не задан — работаем полностью в памяти (для локальной разработки),
 * ничего не ломается, просто прогресс не переживёт перезапуск.
 */
const { Pool } = require('pg');
const logger = require('./logger');

let pool = null;

function isEnabled() { return !!process.env.DATABASE_URL; }

async function init() {
  if (!isEnabled()) {
    logger.warn('DATABASE_URL не задан — работаем в памяти, без сохранения между перезапусками.');
    return;
  }
  const useSSL = process.env.PGSSL !== 'off';
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id BIGSERIAL PRIMARY KEY,
      winner_key TEXT NOT NULL,
      winner_nick TEXT NOT NULL,
      loser_key TEXT NOT NULL,
      loser_nick TEXT NOT NULL,
      rounds INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS matches_winner_idx ON matches (winner_key, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS matches_loser_idx ON matches (loser_key, created_at DESC);`);
  logger.info('База данных подключена, таблицы players и matches готовы.');
}

// Загружает всех игроков в Map (key -> economy object) при старте сервера.
async function loadAll() {
  const map = new Map();
  if (!pool) return map;
  const res = await pool.query('SELECT key, data FROM players');
  for (const row of res.rows) map.set(row.key, row.data);
  logger.info({ count: res.rows.length }, 'Загружено профилей из БД');
  return map;
}

// Сохраняет (создаёт или обновляет) профиль одного игрока. Fire-and-forget с сети —
// вызывающий код не ждёт завершения, ошибки только логируются.
function persist(key, economyObj) {
  if (!pool) return;
  pool.query(
    'INSERT INTO players (key, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = now()',
    [key, economyObj]
  ).catch(err => logger.error({ key, err: err.message }, 'Ошибка сохранения профиля'));
}

async function close() { if (pool) await pool.end(); }

// Записывает результат боя. Fire-and-forget, как persist() — ошибка записи
// истории не должна ронять сам матч или блокировать игрока.
function recordMatch({ winnerKey, winnerNick, loserKey, loserNick, rounds }) {
  if (!pool) return;
  pool.query(
    'INSERT INTO matches (winner_key, winner_nick, loser_key, loser_nick, rounds) VALUES ($1,$2,$3,$4,$5)',
    [winnerKey, winnerNick, loserKey, loserNick, rounds]
  ).catch(err => logger.error({ err: err.message }, 'Ошибка записи истории матча'));
}

// Последние limit матчей игрока (в любой роли — победитель или проигравший),
// в удобном для клиента виде: кто соперник, выиграл ли этот игрок, когда.
async function getHistory(key, limit = 10) {
  if (!pool) return [];
  const res = await pool.query(
    `SELECT winner_key, winner_nick, loser_key, loser_nick, rounds, created_at
     FROM matches WHERE winner_key = $1 OR loser_key = $1
     ORDER BY created_at DESC LIMIT $2`,
    [key, limit]
  );
  return res.rows.map(row => ({
    won: row.winner_key === key,
    opponent: row.winner_key === key ? row.loser_nick : row.winner_nick,
    rounds: row.rounds,
    at: row.created_at,
  }));
}

module.exports = { init, loadAll, persist, close, isEnabled, recordMatch, getHistory };
