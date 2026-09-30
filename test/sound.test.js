'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Sound } = require('../src/sound');
const { delay } = require('./helpers');

// behaviour per command: 'ok' exits 0, 'missing' fails to spawn, 'fail' exits 1, 'hang' never exits.
function fakeSpawn(behaviour, calls) {
  return (command) => {
    calls.push(command);
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      calls.push(`kill ${command}`);
    };
    const mode = behaviour[command] || 'missing';
    setTimeout(() => {
      if (mode === 'ok') child.emit('exit', 0, null);
      if (mode === 'fail') child.emit('exit', 1, null);
      if (mode === 'missing') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    }, 2);
    return child;
  };
}

function makeSound(behaviour, extra = {}) {
  const calls = [];
  const warnings = [];
  const sound = new Sound({
    builtIn: '/builtin/blip.wav',
    platform: 'linux',
    spawn: fakeSpawn(behaviour, calls),
    warn: (m) => warnings.push(m),
    exists: () => true,
    timeoutMs: 30,
    gapMs: 1000,
    ...extra,
  });
  return { sound, calls, warnings };
}

test('falls back to the next player and remembers the one that works', async () => {
  const { sound, calls } = makeSound({ 'pw-play': 'missing', paplay: 'fail', aplay: 'ok' });
  sound.play();
  await delay(30);
  assert.deepEqual(calls, ['pw-play', 'paplay', 'aplay']);
  calls.length = 0;
  sound.play(undefined, { force: true });
  await delay(20);
  assert.deepEqual(calls, ['aplay']);
});

test('kills a player that hangs and tries the next one', async () => {
  const { sound, calls } = makeSound({ 'pw-play': 'hang', paplay: 'ok' });
  sound.play();
  await delay(80);
  assert.deepEqual(calls, ['pw-play', 'kill pw-play', 'paplay']);
});

test('warns once when no player works', async () => {
  const { sound, warnings } = makeSound({}, { gapMs: 0 });
  sound.play();
  await delay(30);
  sound.play();
  await delay(30);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no audio player worked/);
});

test('uses the built-in blip when the custom file is missing', async () => {
  const played = [];
  const sound = new Sound({
    builtIn: '/builtin/blip.wav',
    platform: 'linux',
    exists: () => false,
    warn: (m) => played.push(`warn ${m}`),
    spawn: (command, args) => {
      played.push(args[0]);
      const child = new EventEmitter();
      setTimeout(() => child.emit('exit', 0, null), 2);
      return child;
    },
  });
  sound.play('/nope/custom.wav');
  await delay(20);
  assert.equal(played[0], 'warn Sound file not found: /nope/custom.wav. Playing the built-in blip instead.');
  assert.equal(played[1], '/builtin/blip.wav');
});

test('several finishes within the gap make one blip, unless forced', async () => {
  const { sound, calls } = makeSound({ 'pw-play': 'ok' });
  assert.equal(sound.play(), true);
  assert.equal(sound.play(), false);
  assert.equal(sound.play(undefined, { force: true }), true);
  await delay(20);
  assert.deepEqual(calls, ['pw-play', 'pw-play']);
});
