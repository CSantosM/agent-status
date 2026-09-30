'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createVscode,
  createContext,
  disposeContext,
  createClaudeDir,
  spawnSessionProcess,
  spawnForeignProcess,
  writeSession,
  delay,
} = require('./helpers');

const { state } = createVscode();
const extension = require('../extension');

const processes = [];
test.after(() => processes.forEach((p) => p.kill()));

function setup(t, { preferred = 'panel', context = createContext() } = {}) {
  Object.assign(state, {
    items: [],
    messages: [],
    executed: [],
    updates: [],
    spawned: [],
    failUpdates: false,
    onExecute: undefined,
  });
  state.config.agentStatus = {};
  state.config.claudeCode = { global: preferred === null ? {} : { preferredLocation: preferred }, workspace: {} };
  const claudeDir = createClaudeDir();
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  t.after(() => disposeContext(context));

  const session = (fields, spawn = spawnSessionProcess) => {
    const proc = spawn();
    processes.push(proc);
    return { proc, record: writeSession(claudeDir, proc, fields) };
  };
  const start = async () => {
    extension.activate(context);
    await refresh();
  };
  return { context, claudeDir, session, start };
}

const refresh = () => state.handlers['agentStatus.refresh']();
const open = (id) => state.handlers['agentStatus.open'](id);
const chip = () => state.items[state.items.length - 1];

test('shows one dot per live session and skips dead or reused PIDs', async (t) => {
  const { claudeDir, session, start } = setup(t);
  session({ status: 'busy' });
  const reused = session({ status: 'idle' });
  writeSession(claudeDir, reused.proc, { ...reused.record, procStart: '1' });
  fs.writeFileSync(
    path.join(claudeDir, 'sessions', '4194000.json'),
    JSON.stringify({ pid: 4194000, sessionId: 'dead', cwd: '/tmp', status: 'waiting' }),
  );
  await start();
  assert.equal(chip().text, '$(robot) 🟡');
  assert.equal(chip().color, '#FBC02D');
  assert.equal(chip().visible, true);
});

test('only shows sessions of this window by default', async (t) => {
  const { session, start } = setup(t);
  session({ status: 'busy' }, spawnForeignProcess);
  await start();
  assert.equal(chip().text, '$(robot)');
  assert.equal(chip().color.id, 'disabledForeground');
});

test('blips once when a session goes from working to idle', async (t) => {
  const { claudeDir, session, start } = setup(t);
  const { proc, record } = session({ status: 'busy' });
  await start();
  assert.equal(state.spawned.length, 0, 'nothing plays on startup');

  writeSession(claudeDir, proc, { ...record, status: 'idle' });
  await refresh();
  assert.equal(state.spawned.length, 1);
  assert.equal(state.spawned[0].command, 'pw-play');

  for (const status of ['waiting', 'idle']) {
    writeSession(claudeDir, proc, { ...record, status });
    await refresh();
  }
  assert.equal(state.spawned.length, 1, 'waiting -> idle is not a finish');
});

test('escapes session titles in the trusted hover', async (t) => {
  const { session, start } = setup(t);
  session({ name: '[x](command:workbench.action.terminal.new) $(bug)', nameSource: 'user' });
  await start();
  const hover = chip().tooltip.value;
  assert.ok(!hover.includes('](command:workbench.action.terminal.new)'));
  assert.ok(!hover.includes(' $(bug)'));
});

test('opens in the Claude Code sidebar and gives the preference back', async (t) => {
  const { context, session, start } = setup(t);
  const { record } = session({ status: 'idle' });
  await start();
  await open(record.sessionId);

  assert.equal(state.executed.length, 1);
  const call = state.executed[0];
  assert.equal(call.id, 'claude-vscode.editor.open');
  assert.equal(call.args[0], record.sessionId);
  assert.deepEqual(call.args[5], { programmatic: 'honor-preferred-location' });
  assert.equal(call.preferredLocation, 'sidebar', 'borrowed during the call');
  assert.equal(state.config.claudeCode.global.preferredLocation, 'panel', 'restored afterwards');
  assert.equal(context.globalState.get('pendingPreferredLocationRestore'), undefined);
});

test('two quick clicks do not leave the preference borrowed', async (t) => {
  const { session, start } = setup(t);
  const { record } = session({ status: 'idle' });
  await start();
  state.onExecute = () => delay(20);
  await Promise.all([open(record.sessionId), open(record.sessionId)]);
  assert.deepEqual(
    state.executed.map((e) => e.preferredLocation),
    ['sidebar', 'sidebar'],
  );
  assert.equal(state.config.claudeCode.global.preferredLocation, 'panel');
});

test('a Claude Code that never answers does not keep the preference borrowed', async (t) => {
  const { session, start } = setup(t);
  const { record } = session({ status: 'idle' });
  await start();
  state.onExecute = () => new Promise(() => {});
  const started = Date.now();
  await open(record.sessionId);
  assert.ok(Date.now() - started < 5000);
  assert.equal(state.config.claudeCode.global.preferredLocation, 'panel');
});

test('an unset preference is removed again, not written as "panel"', async (t) => {
  const { session, start } = setup(t, { preferred: null });
  const { record } = session({ status: 'idle' });
  await start();
  await open(record.sessionId);
  assert.equal(state.executed[0].preferredLocation, 'sidebar');
  assert.ok(!('preferredLocation' in state.config.claudeCode.global));
});

test('restores the preference after a click interrupted by a crash', async (t) => {
  const context = createContext();
  await context.globalState.update('pendingPreferredLocationRestore', { previous: 'panel' });
  const { start } = setup(t, { preferred: 'sidebar', context });
  await start();
  await delay(20);
  assert.equal(state.config.claudeCode.global.preferredLocation, 'panel');
  assert.equal(context.globalState.get('pendingPreferredLocationRestore'), undefined);
});

test('never edits workspace settings', async (t) => {
  const { session, start } = setup(t);
  state.config.claudeCode.workspace.preferredLocation = 'panel';
  const { record } = session({ status: 'idle' });
  await start();
  await open(record.sessionId);
  assert.equal(state.updates.length, 0);
  assert.equal(state.executed[0].preferredLocation, 'panel');
});

test('still opens the session when settings cannot be written', async (t) => {
  const { session, start } = setup(t);
  const { record } = session({ status: 'idle' });
  await start();
  state.failUpdates = true;
  await open(record.sessionId);
  assert.equal(state.executed.length, 1);
  assert.equal(state.executed[0].preferredLocation, 'panel');
  assert.deepEqual(
    state.messages.filter(([level]) => level === 'error'),
    [],
  );
});

test('does not open sessions that run in another window', async (t) => {
  const { session, start } = setup(t);
  state.config.agentStatus.scope = 'all';
  const { record } = session({ status: 'idle' }, spawnForeignProcess);
  await start();
  await open(record.sessionId);
  assert.equal(state.executed.length, 0);
  assert.match(state.messages[0][1], /another VS Code window/);
});

test('falls back to defaults for invalid settings', async (t) => {
  const { session, start } = setup(t);
  Object.assign(state.config.agentStatus, { icon: '$(evil) x', maxDots: 'lots', dots: { busy: 42 }, scope: 'nope' });
  session({ status: 'busy' });
  await start();
  assert.equal(chip().text, '$(robot) 🟡');
});
