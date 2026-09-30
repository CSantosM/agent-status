'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createClaudeDir, spawnSessionProcess, writeSession } = require('./helpers');
const {
  readSessionRecords,
  isAlive,
  ownership,
  localPidDomain,
  filterByDomain,
  dedupeSessions,
} = require('../src/sessions');

test('readSessionRecords keeps valid records and skips broken ones', async () => {
  const dir = createClaudeDir();
  const sessions = path.join(dir, 'sessions');
  fs.writeFileSync(path.join(sessions, '100.json'), JSON.stringify({ pid: 100, sessionId: 'a', cwd: '/x' }));
  fs.writeFileSync(path.join(sessions, '101.json'), '{"pid":101,"sessionId":"b"'); // mid-write
  fs.writeFileSync(path.join(sessions, '102.json'), JSON.stringify({ pid: 102, sessionId: 'c', cwd: '/x', spare: true }));
  fs.writeFileSync(path.join(sessions, '103.json'), JSON.stringify({ pid: '103', sessionId: 'd', cwd: '/x' }));
  fs.writeFileSync(path.join(sessions, '104.key'), 'secret');
  const records = await readSessionRecords(sessions);
  assert.deepEqual(records.map((r) => r.sessionId), ['a']);
  assert.deepEqual(await readSessionRecords(path.join(dir, 'missing')), []);
});

test('isAlive tells live, dead and reused PIDs apart', () => {
  const proc = spawnSessionProcess();
  try {
    assert.equal(isAlive({ pid: proc.pid, procStart: proc.procStart }), true);
    assert.equal(isAlive({ pid: proc.pid }), true);
    assert.equal(isAlive({ pid: proc.pid, procStart: '1' }), false, 'same PID, different process');
  } finally {
    proc.kill();
  }
  assert.equal(isAlive({ pid: 2 ** 22 + 12345 }), false);
});

test('ownership follows the process tree to the extension host or a terminal', () => {
  const proc = spawnSessionProcess();
  try {
    const record = { pid: proc.pid };
    assert.deepEqual(ownership(record, { shellPids: new Map(), hostPid: process.pid }), { owned: true });
    assert.deepEqual(ownership(record, { shellPids: new Map([[process.pid, {}]]), hostPid: -1 }), {
      owned: true,
      terminalPid: process.pid,
    });
    assert.deepEqual(ownership(record, { shellPids: new Map(), hostPid: -1 }), { owned: false });
  } finally {
    proc.kill();
  }
});

test('filterByDomain drops other machines only once the format is confirmed', () => {
  const domain = localPidDomain();
  assert.match(domain, /^linux:[0-9a-f]+:pid:\[\d+\]$/);
  const here = { sessionId: 'here', pidDomain: domain };
  const container = { sessionId: 'container', pidDomain: 'linux:other:pid:[1]' };
  const legacy = { sessionId: 'legacy' };
  assert.deepEqual(filterByDomain([here, container, legacy], domain), [here, legacy]);
  // Nothing matches (the format changed?): keep everything rather than hide every session.
  assert.deepEqual(filterByDomain([container, legacy], domain), [container, legacy]);
});

test('dedupeSessions prefers this window, then the freshest record', () => {
  const sessions = dedupeSessions([
    { id: 'x', owned: false, updatedAt: 3 },
    { id: 'x', owned: true, updatedAt: 1 },
    { id: 'y', owned: true, updatedAt: 1 },
    { id: 'y', owned: true, updatedAt: 2 },
  ]);
  assert.deepEqual(sessions, [
    { id: 'x', owned: true, updatedAt: 1 },
    { id: 'y', owned: true, updatedAt: 2 },
  ]);
});

test('writeSession helper produces records the reader accepts', async () => {
  const dir = createClaudeDir();
  const proc = spawnSessionProcess();
  try {
    const record = writeSession(dir, proc, { status: 'busy' });
    const [read] = await readSessionRecords(path.join(dir, 'sessions'));
    assert.equal(read.sessionId, record.sessionId);
    assert.equal(isAlive(read), true);
  } finally {
    proc.kill();
  }
});
