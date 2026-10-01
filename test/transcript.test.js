'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createClaudeDir } = require('./helpers');
const { TranscriptIndex, describeTool, resolveTitle } = require('../src/providers/claude-code/transcript');

const line = (entry) => JSON.stringify(entry) + '\n';
const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 10, 0, seconds)).toISOString();
const toolUse = (name, input, seconds, extra = {}) =>
  line({ type: 'assistant', timestamp: at(seconds), message: { content: [{ type: 'tool_use', name, input }] }, ...extra });
const toolResult = (seconds) =>
  line({ type: 'user', timestamp: at(seconds), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const prompt = (seconds, text = 'do it') => line({ type: 'user', timestamp: at(seconds), message: { role: 'user', content: text } });

function setup(lines = [], { cwd = '/tmp/proj', id = 's1', options } = {}) {
  const dir = createClaudeDir();
  const projects = path.join(dir, 'projects');
  const file = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(''));
  const index = new TranscriptIndex(projects, { recheckMs: 0, ...options });
  return { file, index, record: { sessionId: id, cwd }, append: (...more) => more.forEach((chunk) => fs.appendFileSync(file, chunk)) };
}

test('takes the latest real title entries', async () => {
  const { index, record } = setup([
    line({ type: 'ai-title', aiTitle: 'Old AI title' }),
    line({ type: 'custom-title', customTitle: 'feat/old' }),
    line({ type: 'ai-title', aiTitle: 'New AI title' }),
    line({ type: 'custom-title', customTitle: 'feat/new' }),
    // A message quoting a title entry must not count.
    line({ type: 'user', message: { content: '{"type":"custom-title","customTitle":"fake"}' } }),
  ]);
  const summary = await index.get(record);
  assert.equal(summary.customTitle, 'feat/new');
  assert.equal(summary.aiTitle, 'New AI title');
});

test('follows the transcript as it grows, reading only what was appended', async () => {
  const { index, record, append } = setup([prompt(0), toolUse('Read', { file_path: '/tmp/proj/a.ts' }, 1)]);
  assert.equal((await index.get(record)).lastTool.name, 'Read');

  append(toolResult(2), toolUse('Edit', { file_path: '/tmp/proj/a.ts', old_string: 'x'.repeat(5000) }, 3));
  const summary = await index.get(record);
  assert.equal(summary.lastTool.name, 'Edit');
  assert.ok(!('old_string' in summary.lastTool.input), 'large inputs are not kept');
  assert.deepEqual([...summary.files.keys()], ['/tmp/proj/a.ts']);
});

test('a new prompt clears the previous turn\'s tool call', async () => {
  const { index, record, append } = setup([prompt(0), toolUse('Bash', { command: 'npm test' }, 1), toolResult(2)]);
  assert.equal((await index.get(record)).lastTool.name, 'Bash', 'a tool result keeps the call');
  append(prompt(3, 'next task'));
  assert.equal((await index.get(record)).lastTool, undefined);
});

test('collects edited files from the session and its subagents, most recent last', async () => {
  const { file, index, record } = setup([
    toolUse('Write', { file_path: '/tmp/proj/new.ts' }, 1),
    toolUse('Edit', { file_path: '/tmp/proj/a.ts' }, 2),
    toolUse('Read', { file_path: '/tmp/proj/read-only.ts' }, 3),
    toolUse('NotebookEdit', { notebook_path: '/tmp/proj/n.ipynb' }, 4),
    toolUse('Edit', { file_path: '/tmp/proj/new.ts' }, 5),
  ]);
  const subagents = path.join(path.dirname(file), record.sessionId, 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(subagents, 'agent-1.jsonl'), toolUse('Edit', { file_path: '/tmp/proj/by-subagent.ts' }, 6, { isSidechain: true }));

  const summary = await index.get(record);
  assert.deepEqual([...summary.files.keys()], ['/tmp/proj/a.ts', '/tmp/proj/n.ipynb', '/tmp/proj/new.ts', '/tmp/proj/by-subagent.ts']);
  assert.equal(summary.lastTool.name, 'Edit', "a subagent's calls do not replace the session's own");
  assert.equal(summary.lastTool.input.file_path, '/tmp/proj/new.ts');
});

test('starts over when the transcript is rewritten', async () => {
  const { file, index, record } = setup([toolUse('Edit', { file_path: '/tmp/proj/gone.ts' }, 1), line({ type: 'ai-title', aiTitle: 'Before' })]);
  assert.equal((await index.get(record)).aiTitle, 'Before');
  fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'After' }));
  const summary = await index.get(record);
  assert.equal(summary.aiTitle, 'After');
  assert.deepEqual([...summary.files.keys()], []);
});

test('reads only the tail of a huge transcript, skipping the cut line', async () => {
  const filler = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] } });
  const { index, record } = setup(
    [toolUse('Edit', { file_path: '/tmp/proj/early.ts' }, 1), filler, filler, filler, line({ type: 'ai-title', aiTitle: 'Kept' })],
    { options: { firstReadMax: 5000, tailBytes: 6000 } },
  );
  const summary = await index.get(record);
  assert.equal(summary.aiTitle, 'Kept');
  assert.deepEqual([...summary.files.keys()], [], 'the early edit is beyond the tail');
});

test('keeps a multi-byte character split across reads intact', async () => {
  const { index, record, append } = setup([]);
  const entry = line({ type: 'custom-title', customTitle: 'Revisión 🟡 añadida' });
  const bytes = Buffer.from(entry);
  const cut = bytes.indexOf(Buffer.from('🟡')) + 2;
  append(bytes.subarray(0, cut));
  await index.get(record);
  append(bytes.subarray(cut));
  assert.equal((await index.get(record)).customTitle, 'Revisión 🟡 añadida');
});

test('finds a transcript stored under a different folder name', async () => {
  const dir = createClaudeDir();
  const file = path.join(dir, 'projects', 'shortened-name', 'two.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, line({ type: 'ai-title', aiTitle: 'Searched' }));
  const index = new TranscriptIndex(path.join(dir, 'projects'), { recheckMs: 0 });
  assert.equal((await index.get({ sessionId: 'two', cwd: '/somewhere/else' })).aiTitle, 'Searched');
  assert.equal((await index.get({ sessionId: 'none', cwd: '/x' })).aiTitle, undefined);
});

test('describeTool puts tool calls into words', () => {
  assert.deepEqual(describeTool({ name: 'Edit', input: { file_path: '/a/b/auth.ts' } }), { text: 'Editing auth.ts', icon: 'edit' });
  assert.equal(describeTool({ name: 'Bash', input: { command: 'npm test\nmore', description: 'Run the tests' } }).text, 'Running: Run the tests');
  assert.equal(describeTool({ name: 'Bash', input: { command: 'npm test\nmore' } }).text, 'Running npm test');
  assert.equal(describeTool({ name: 'WebFetch', input: { url: 'https://example.com/x' } }).text, 'Reading example.com');
  assert.equal(describeTool({ name: 'Agent', input: { description: 'Explore the API' } }).text, 'Running a subagent: Explore the API');
  assert.equal(describeTool({ name: 'mcp__github__create_issue', input: {} }).text, 'Using create_issue (github)');
  assert.deepEqual(describeTool({ name: 'Mystery', input: {} }), { text: 'Using Mystery', icon: 'tools' });
});

test('resolveTitle prefers the name you gave the session', () => {
  const record = { sessionId: 'abcdef123', cwd: '/tmp/proj', name: 'proj-2e', nameSource: 'derived' };
  assert.equal(resolveTitle(record, { customTitle: 'feat/x', aiTitle: 'AI' }), 'feat/x');
  assert.equal(resolveTitle(record, { aiTitle: 'AI' }), 'AI');
  assert.equal(resolveTitle(record, {}), 'proj-2e');
  assert.equal(resolveTitle({ ...record, name: 'Mine', nameSource: 'user' }, { customTitle: 'feat/x' }), 'Mine');
  assert.equal(resolveTitle({ sessionId: 'abcdef123', cwd: '/' }, {}), 'abcdef12');
});
