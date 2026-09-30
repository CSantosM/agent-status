'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createClaudeDir } = require('./helpers');
const { TitleCache, readTitles, resolveTitle } = require('../src/titles');

const line = (entry) => JSON.stringify(entry) + '\n';

function writeTranscript(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(''));
  return fs.statSync(file).size;
}

test('readTitles takes the latest real title entries', async () => {
  const dir = createClaudeDir();
  const file = path.join(dir, 't.jsonl');
  const size = writeTranscript(file, [
    line({ type: 'ai-title', aiTitle: 'Old AI title' }),
    line({ type: 'custom-title', customTitle: 'feat/old' }),
    line({ type: 'ai-title', aiTitle: 'New AI title' }),
    line({ type: 'custom-title', customTitle: 'feat/new' }),
    // A message quoting a title entry must not count.
    line({ type: 'user', message: '{"type":"custom-title","customTitle":"fake"}' }),
  ]);
  assert.deepEqual(await readTitles(file, size), { customTitle: 'feat/new', aiTitle: 'New AI title' });
});

test('readTitles copes with a tail that starts mid-line', async () => {
  const dir = createClaudeDir();
  const file = path.join(dir, 't.jsonl');
  const filler = line({ type: 'assistant', text: 'x'.repeat(700 * 1024) });
  const size = writeTranscript(file, [filler, line({ type: 'ai-title', aiTitle: 'Kept' })]);
  assert.deepEqual(await readTitles(file, size), { aiTitle: 'Kept' });
});

test('TitleCache finds transcripts by folder name, then by searching', async () => {
  const dir = createClaudeDir();
  const projects = path.join(dir, 'projects');
  writeTranscript(path.join(projects, '-tmp-my-project', 'one.jsonl'), [line({ type: 'ai-title', aiTitle: 'Direct' })]);
  writeTranscript(path.join(projects, 'shortened-name', 'two.jsonl'), [line({ type: 'ai-title', aiTitle: 'Searched' })]);
  const cache = new TitleCache(projects);
  assert.equal((await cache.get({ sessionId: 'one', cwd: '/tmp/my.project' })).aiTitle, 'Direct');
  assert.equal((await cache.get({ sessionId: 'two', cwd: '/somewhere/else' })).aiTitle, 'Searched');
  assert.equal((await cache.get({ sessionId: 'none', cwd: '/x' })).aiTitle, undefined);
});

test('TitleCache picks up a renamed session after the recheck interval', async () => {
  const dir = createClaudeDir();
  const file = path.join(dir, 'projects', '-x', 's.jsonl');
  writeTranscript(file, [line({ type: 'custom-title', customTitle: 'before' })]);
  const cache = new TitleCache(path.join(dir, 'projects'), { recheckMs: 0 });
  assert.equal((await cache.get({ sessionId: 's', cwd: '/x' })).customTitle, 'before');
  fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'after' }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal((await cache.get({ sessionId: 's', cwd: '/x' })).customTitle, 'after');
});

test('resolveTitle prefers the name you gave the session', () => {
  const record = { sessionId: 'abcdef123', cwd: '/tmp/proj', name: 'proj-2e', nameSource: 'derived' };
  assert.equal(resolveTitle(record, { customTitle: 'feat/x', aiTitle: 'AI' }), 'feat/x');
  assert.equal(resolveTitle(record, { aiTitle: 'AI' }), 'AI');
  assert.equal(resolveTitle(record, {}), 'proj-2e');
  assert.equal(resolveTitle({ ...record, name: 'Mine', nameSource: 'user' }, { customTitle: 'feat/x' }), 'Mine');
  assert.equal(resolveTitle({ sessionId: 'abcdef123', cwd: '/' }, {}), 'abcdef12');
});
