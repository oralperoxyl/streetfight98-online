'use strict';
/* Обёртка над pino — единая точка настройки логирования.
 * В разработке — читаемый цветной вывод (pino-pretty недоступен без доп.
 * зависимости, поэтому используем встроенный pino с уровнем из env).
 * LOG_LEVEL управляет подробностью: trace/debug/info/warn/error/silent.
 */
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'streetfight98' },
});

module.exports = logger;
