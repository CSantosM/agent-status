'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createClaudeDir } = require('./helpers');
const { readSessionRecords, normalize } = require('../src/providers/claude-code/records');
const { createClaudeCodeProvider } = require('../src/providers/claude-code');

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

test('normalize maps Claude Code records to the provider-neutral shape', () => {
  const session = normalize(
    { pid: 7, sessionId: 's', cwd: '/x', status: 'waiting', waitingFor: 'Bash', entrypoint: 'claude-vscode', startedAt: 1790768543 },
    'claude-code',
  );
  assert.equal(session.provider, 'claude-code');
  assert.equal(session.id, 's');
  assert.equal(session.surface, 'editor');
  assert.equal(session.startedAt, 1790768543000, 'seconds become milliseconds');
  assert.equal(normalize({ pid: 7, sessionId: 's', cwd: '/x', entrypoint: 'cli' }, 'claude-code').surface, 'cli');
  assert.equal(normalize({ pid: 7, sessionId: 's', cwd: '/x', entrypoint: 'sdk-ts' }, 'claude-code').surface, 'other');
});

test('the provider lists and describes sessions from its config directory', async () => {
  const dir = createClaudeDir();
  fs.writeFileSync(
    path.join(dir, 'sessions', '200.json'),
    JSON.stringify({ pid: 200, sessionId: 'abc', cwd: '/tmp/p', status: 'busy', entrypoint: 'claude-vscode' }),
  );
  const transcript = path.join(dir, 'projects', '-tmp-p', 'abc.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    [
      { type: 'custom-title', customTitle: 'feat/login', gitBranch: 'feat/login' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/p/a.ts' } }] } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  const provider = createClaudeCodeProvider({ configDir: dir });
  const [session] = await provider.listSessions();
  assert.equal(session.id, 'abc');
  const details = await provider.describe(session);
  assert.equal(details.title, 'feat/login');
  assert.deepEqual(details.action, { text: 'Editing a.ts', icon: 'edit' });
  assert.deepEqual(details.files.map((f) => f.path), ['/tmp/p/a.ts']);
  assert.equal(details.branch, 'feat/login');
  assert.equal(provider.canOpen(session), false, 'no opener, no Claude Code extension');
});
