'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatElapsed, truncate, escapeMarkdown, toMillis, withTimeout, delay } = require('../src/util');

test('formatElapsed uses minute granularity', () => {
  assert.equal(formatElapsed(-5000), '<1 min');
  assert.equal(formatElapsed(59 * 1000), '<1 min');
  assert.equal(formatElapsed(3 * 60000), '3 min');
  assert.equal(formatElapsed(60 * 60000), '1 h');
  assert.equal(formatElapsed(75 * 60000), '1 h 15 min');
  assert.equal(formatElapsed(50 * 3600000), '2 d');
});

test('truncate never cuts an emoji in half', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('🟡🟡🟡🟡', 3), '🟡🟡…');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
});

test('escapeMarkdown neutralizes links, icons and line breaks', () => {
  const escaped = escapeMarkdown('[x](command:evil) $(bug)\nnext');
  assert.ok(!escaped.includes('](command:'));
  assert.ok(!escaped.includes('$('));
  assert.ok(!escaped.includes('\n'));
});

test('toMillis accepts milliseconds and seconds, rejects junk', () => {
  assert.equal(toMillis(1790768543823), 1790768543823);
  assert.equal(toMillis(1790768543), 1790768543000);
  assert.equal(toMillis(0), undefined);
  assert.equal(toMillis('123'), undefined);
  assert.equal(toMillis(NaN), undefined);
});

test('withTimeout reports values, timeouts and early rejections', async () => {
  assert.deepEqual(await withTimeout(Promise.resolve(7), 50), { value: 7 });
  assert.deepEqual(await withTimeout(new Promise(() => {}), 20), { timedOut: true });
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50), /boom/);
  // A rejection after the deadline must not surface as an unhandled rejection.
  const late = delay(40).then(() => {
    throw new Error('late');
  });
  assert.deepEqual(await withTimeout(late, 10), { timedOut: true });
  await delay(50);
});
