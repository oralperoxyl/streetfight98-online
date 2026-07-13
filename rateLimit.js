'use strict';
/* Простой sliding-window rate limiter в памяти.
 * Используется для ограничения частоты WebSocket-сообщений от одного
 * соединения — защита от спама/DoS одним клиентом (случайного или
 * намеренного). Не персистентный и не распределённый — этого достаточно
 * для одного процесса; при масштабировании на несколько инстансов нужен
 * будет Redis-бэкенд с той же сигнатурой.
 */

// Создаёт независимый лимитер: maxEvents событий за windowMs миллисекунд.
// Возвращает функцию check(key) -> {allowed, remaining, retryAfterMs}.
function createRateLimiter(maxEvents, windowMs) {
  const hits = new Map(); // key -> массив меток времени (мс) внутри текущего окна

  function check(key) {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) { arr = []; hits.set(key, arr); }
    // выкидываем метки старше окна
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (arr.length >= maxEvents) {
      const retryAfterMs = windowMs - (now - arr[0]);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    arr.push(now);
    return { allowed: true, remaining: maxEvents - arr.length, retryAfterMs: 0 };
  }

  // Периодическая уборка ключей без недавней активности — иначе Map растёт
  // вечно за счёт игроков, которые давно отключились.
  function sweep() {
    const now = Date.now();
    for (const [key, arr] of hits.entries()) {
      while (arr.length && now - arr[0] > windowMs) arr.shift();
      if (arr.length === 0) hits.delete(key);
    }
  }

  function reset(key) { hits.delete(key); }
  function size() { return hits.size; }

  return { check, sweep, reset, size };
}

module.exports = { createRateLimiter };
