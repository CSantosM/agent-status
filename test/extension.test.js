'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
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
const { escapeMarkdown } = require('../src/util');

const processes = [];
test.after(() => processes.forEach((p) => p.kill()));

function setup(t, { preferred = 'panel', context = createContext() } = {}) {
  Object.assign(state, {
    items: [],
    views: [],
    contentProviders: {},
    respond: undefined,
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
  // Transcript entries for a session, where Claude Code would write them.
  const transcript = (record, entries) => {
    const file = path.join(claudeDir, 'projects', record.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${record.sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  };
  const start = async () => {
    extension.activate(context);
    await refresh();
  };
  return { context, claudeDir, session, transcript, start };
}

const refresh = () => state.handlers['agentStatus.refresh']();
const open = (id) => state.handlers['agentStatus.open'](`claude-code:${id}`);
const chip = () => state.items[state.items.length - 1];
const view = () => state.views[state.views.length - 1];
const edit = (file) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: file } }] } });

function git(cwd, ...args) {
  childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

function createRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-repo-')));
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'auth.ts'), 'export const a = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

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
  assert.equal(path.basename(state.spawned[0].args[0]), 'finish.wav');

  for (const status of ['waiting', 'idle']) {
    writeSession(claudeDir, proc, { ...record, status });
    await refresh();
  }
  assert.equal(state.spawned.length, 1, 'waiting -> idle is not a finish');
});

test('plays the double blip when a session stops to wait for you', async (t) => {
  const { claudeDir, session, start } = setup(t);
  const { proc, record } = session({ status: 'busy' });
  await start();
  writeSession(claudeDir, proc, { ...record, status: 'waiting', waitingFor: 'Permission to run Bash' });
  await refresh();
  assert.deepEqual(state.spawned.map((s) => path.basename(s.args[0])), ['waiting.wav']);
});

test('when one session finishes and another waits, only the waiting sound plays', async (t) => {
  const { claudeDir, session, start } = setup(t);
  const a = session({ status: 'busy' });
  const b = session({ status: 'busy' });
  await start();
  writeSession(claudeDir, a.proc, { ...a.record, status: 'idle' });
  writeSession(claudeDir, b.proc, { ...b.record, status: 'waiting' });
  await refresh();
  assert.deepEqual(state.spawned.map((s) => path.basename(s.args[0])), ['waiting.wav']);
});

test('each sound can be turned off', async (t) => {
  const { claudeDir, session, start } = setup(t);
  Object.assign(state.config.agentStatus, { soundOnWaiting: false, soundOnFinish: false });
  const { proc, record } = session({ status: 'busy' });
  await start();
  for (const status of ['waiting', 'busy', 'idle']) {
    writeSession(claudeDir, proc, { ...record, status });
    await refresh();
  }
  assert.equal(state.spawned.length, 0);
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

test('notifies when a session stops to wait for you, and opens it from the notification', async (t) => {
  const { claudeDir, session, start } = setup(t);
  const { proc, record } = session({ status: 'busy' });
  await start();
  state.respond = (message, buttons) => (buttons.includes('Open') ? 'Open' : undefined);
  writeSession(claudeDir, proc, { ...record, status: 'waiting', waitingFor: 'Permission to run Bash' });
  await refresh();
  await delay(30);
  const [level, message, buttons] = state.messages[0];
  assert.equal(level, 'info');
  assert.match(message, /needs your decision: Permission to run Bash/);
  assert.deepEqual(buttons, ['Open', 'Turn Off']);
  assert.equal(state.executed[0].id, 'claude-vscode.editor.open');
  assert.equal(view().badge.value, 1, 'the panel badge counts waiting sessions');
});

test('"Turn Off" in the notification disables it', async (t) => {
  const { claudeDir, session, start } = setup(t);
  const { proc, record } = session({ status: 'busy' });
  await start();
  state.respond = () => 'Turn Off';
  writeSession(claudeDir, proc, { ...record, status: 'waiting' });
  await refresh();
  await delay(30);
  assert.equal(state.config.agentStatus.notifyOnWaiting, false);
});

test('shows what a working session is doing', async (t) => {
  const { session, transcript, start } = setup(t);
  const { record } = session({ status: 'busy' });
  transcript(record, [edit('/tmp/project/auth.ts')]);
  await start();
  assert.ok(chip().tooltip.value.includes(`$(edit) ${escapeMarkdown('Editing auth.ts')}`));
});

test('groups sessions by branch and worktree when asked', async (t) => {
  const { session, start } = setup(t);
  const root = createRepo();
  const tree = path.join(root, '.claude', 'worktrees', 'feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feat/x', tree);
  session({ status: 'busy', cwd: root, startedAt: 1 });
  session({ status: 'busy', cwd: tree, startedAt: 2 });
  session({ status: 'idle', cwd: root, startedAt: 3 });
  state.config.agentStatus.groupBy = 'branch';
  await start();
  assert.equal(chip().text, '$(robot) 🟡🟢 · 🟡', 'the two sessions sharing main sit together');
  const hover = chip().tooltip.value;
  assert.ok(hover.includes('$(git-branch) **main**'));
  assert.ok(hover.includes(`$(git-branch) **feat/x** · ${escapeMarkdown(`${path.basename(root)} · worktree`)}`));

  const groups = await view().provider.getChildren();
  assert.deepEqual(groups.map((g) => g.item.label), ['main', 'feat/x']);
  assert.equal((await view().provider.getChildren(groups[0])).length, 2);
});

test('the panel lists edited files with their changes and opens a diff against HEAD', async (t) => {
  const { session, transcript, start } = setup(t);
  const root = createRepo();
  const file = path.join(root, 'auth.ts');
  fs.writeFileSync(file, 'export const a = 2;\nexport const b = 3;\n');
  const { record } = session({ status: 'busy', cwd: root });
  transcript(record, [edit(file)]);
  await start();

  const [node] = await view().provider.getChildren();
  assert.equal(node.item.description.split(' · ')[0], 'Working');
  const children = await view().provider.getChildren(node);
  assert.equal(children[0].item.label, 'Editing auth.ts');
  const filesNode = children.find((c) => c.kind === 'files');
  assert.equal(filesNode.item.description, '1');
  const [fileNode] = await view().provider.getChildren(filesNode);
  assert.equal(fileNode.item.description, '+2 −1');

  await state.handlers['agentStatus.openFileDiff'](fileNode);
  const diff = state.executed.find((e) => e.id === 'vscode.diff');
  assert.equal(diff.args[1].fsPath, file);
  const head = await state.contentProviders['agent-status-head'].provideTextDocumentContent(diff.args[0]);
  assert.equal(head, 'export const a = 1;\n');
});

test('the panel shows nothing when no sessions run, leaving room for its welcome message', async (t) => {
  const { start } = setup(t);
  await start();
  assert.deepEqual(await view().provider.getChildren(), []);
  assert.equal(view().badge, undefined);
});
