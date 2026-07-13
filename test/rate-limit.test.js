'use strict';
/* Юнит-тест лимитера — без сети, без сервера. Запуск: node test/rate-limit.test.js */
const { createRateLimiter } = require('../rateLimit');

let failed = 0;
function check(name, cond) {
  if (cond) console.log('PASS:', name);
  else { console.log('FAIL:', name); failed++; }
}

function testBasicWindow() {
  const rl = createRateLimiter(5, 100);
  let allowed = 0, denied = 0;
  for (let i = 0; i < 8; i++) { const r = rl.check('a'); r.allowed ? allowed++ : denied++; }
  check('разрешает ровно maxEvents, остальное отклоняет', allowed === 5 && denied === 3);
}

function testKeyIndependence() {
  const rl = createRateLimiter(2, 1000);
  rl.check('x'); rl.check('x');
  const xBlocked = !rl.check('x').allowed;
  const yAllowed = rl.check('y').allowed;
  check('разные ключи не влияют друг на друга', xBlocked && yAllowed);
}

function testReset() {
  const rl = createRateLimiter(1, 10000);
  rl.check('z');
  const blockedBeforeReset = !rl.check('z').allowed;
  rl.reset('z');
  const allowedAfterReset = rl.check('z').allowed;
  check('reset() снимает лимит для ключа', blockedBeforeReset && allowedAfterReset);
}

function testWindowExpiry(done) {
  const rl = createRateLimiter(1, 80);
  rl.check('w');
  const blocked = !rl.check('w').allowed;
  setTimeout(() => {
    const allowedAfter = rl.check('w').allowed;
    check('окно истекает и снова разрешает', blocked && allowedAfter);
    done();
  }, 100);
}

function testSweep(done) {
  const rl = createRateLimiter(3, 50);
  rl.check('p'); rl.check('q');
  setTimeout(() => {
    rl.sweep();
    check('sweep удаляет неактивные ключи', rl.size() === 0);
    done();
  }, 80);
}

testBasicWindow();
testKeyIndependence();
testReset();
testWindowExpiry(() => {
  testSweep(() => {
    console.log(failed === 0 ? '\nALL RATE LIMIT TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  });
});
