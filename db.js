'use strict';
/* Слой хранения профилей игроков в Postgres.
 * Храним экономику каждого игрока одной JSONB-колонкой — данные ещё активно
 * меняются формой (жетоны, снаряжение, наёмники, уровни), нормализовать рано.
 * Если DATABASE_URL не задан — работаем полностью в памяти (для локальной разработки),
 * ничего не ломается, просто прогресс не переживёт перезапуск.
 */
const { Pool } = require('pg');

let pool = null;

function isEnabled() { return !!process.env.DATABASE_URL; }

async function init() {
  if (!isEnabled()) {
    console.log('DATABASE_URL не задан — работаем в памяти, без сохранения между перезапусками.');
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
  console.log('База данных подключена, таблица players готова.');
}

// Загружает всех игроков в Map (key -> economy object) при старте сервера.
async function loadAll() {
  const map = new Map();
  if (!pool) return map;
  const res = await pool.query('SELECT key, data FROM players');
  for (const row of res.rows) map.set(row.key, row.data);
  console.log(`Загружено профилей из БД: ${res.rows.length}`);
  return map;
}

// Сохраняет (создаёт или обновляет) профиль одного игрока. Fire-and-forget с сети —
// вызывающий код не ждёт завершения, ошибки только логируются.
function persist(key, economyObj) {
  if (!pool) return;
  pool.query(
    'INSERT INTO players (key, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = now()',
    [key, economyObj]
  ).catch(err => console.error('Ошибка сохранения профиля', key, err.message));
}

async function close() { if (pool) await pool.end(); }

module.exports = { init, loadAll, persist, close, isEnabled };
