'use strict';
/* Проверка подлинности initData, которую Telegram Mini App передаёт клиенту.
 * Алгоритм из официальной документации Telegram:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret_key = HMAC_SHA256("WebAppData", bot_token)
 * data_check_string = все поля initData кроме hash, отсортированные по ключу,
 *                     склеенные как "key=value" через \n
 * hash_ожидаемый = HMAC_SHA256(secret_key, data_check_string) в hex
 * Данные подлинны, если hash_ожидаемый === hash из initData.
 */
const crypto = require('crypto');

// Возвращает распарсенный объект user {id, first_name, ...}, если подпись верна и не устарела,
// иначе null. maxAgeSec ограничивает возраст initData (Telegram обновляет auth_date при каждом открытии).
function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch (_) { return null; }

  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (maxAgeSec > 0 && authDate > 0) {
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > maxAgeSec) return null;
  }

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try { return JSON.parse(userRaw); } catch (_) { return null; }
}

module.exports = { verifyInitData };
