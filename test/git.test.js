'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGit, findRepo } = require('../src/git');

function git(cwd, ...args) {
  childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

function createRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-git-')));
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'keep\n');
  fs.mkdirSync(path.join(root, 'src'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

test('findRepo reads the branch, also from a subfolder and a worktree', async () => {
  const root = createRepo();
  assert.deepEqual(await findRepo(path.join(root, 'src')), {
    root,
    mainRoot: root,
    name: path.basename(root),
    branch: 'main',
    label: 'main',
    worktree: false,
  });

  const tree = path.join(root, '.claude', 'worktrees', 'feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feat/x', tree);
  const info = await findRepo(tree);
  assert.equal(info.root, tree);
  assert.equal(info.branch, 'feat/x');
  assert.equal(info.worktree, true);
  assert.equal(info.name, path.basename(root), 'named after the main repository');
  assert.equal(info.mainRoot, root);

  git(root, 'checkout', '-q', '--detach');
  assert.match((await findRepo(root)).label, /^detached at [0-9a-f]{7}$/);
  assert.equal(await findRepo(os.tmpdir()), undefined);
});

test('fileChanges reports status and line counts against HEAD', async () => {
  const root = createRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(root, 'src', 'new.txt'), 'hello\n');
  fs.rmSync(path.join(root, 'b.txt'));
  const files = ['a.txt', 'src/new.txt', 'b.txt'].map((f) => path.join(root, f));
  const changes = await createGit().fileChanges(root, [...files, '/outside/x.txt']);
  assert.deepEqual(changes.get(files[0]), { status: 'modified', added: 2, removed: 1 });
  assert.equal(changes.get(files[2]).status, 'deleted');
  // Untracked files never reach the panel (it lists tracked files), and git diff does not see them.
  assert.equal(changes.has('/outside/x.txt'), false);
});

test('contentAt returns a file at a commit, or nothing where it did not exist', async () => {
  const root = createRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  const g = createGit();
  assert.equal(await g.contentAt(root, path.join(root, 'a.txt')), 'one\ntwo\n');
  assert.equal(await g.contentAt(root, path.join(root, 'src', 'missing.txt')), '');
});

test('on a branch, changes add up from where it left main, committed or not', async () => {
  const root = createRepo();
  const forkPoint = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  git(root, 'checkout', '-q', '-b', 'feat/x');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  git(root, 'commit', '-q', '-am', 'first');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  git(root, 'commit', '-q', '-am', 'second');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n'); // and one not committed
  fs.rmSync(path.join(root, 'b.txt'));
  git(root, 'commit', '-q', '-am', 'delete b');

  const g = createGit();
  const base = await g.compareBase(root, { since: Date.now() });
  assert.equal(base.ref, forkPoint);
  assert.equal(base.label, 'main');
  const files = ['a.txt', 'b.txt'].map((f) => path.join(root, f));
  const changes = await g.fileChanges(root, files, base.ref);
  assert.deepEqual(changes.get(files[0]), { status: 'modified', added: 4, removed: 1 });
  assert.equal(changes.get(files[1]).status, 'deleted');
  assert.deepEqual([...(await g.trackedFiles(root, files, base.ref))].sort(), files.sort(), 'a deleted file still counts');
  assert.deepEqual([...(await g.trackedFiles(root, files))], [files[0]]);
});

test('on main, changes add up from where HEAD was when the session started', async () => {
  const root = createRepo();
  const before = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  await new Promise((resolve) => setTimeout(resolve, 1100)); // The reflog counts in seconds.
  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  git(root, 'commit', '-q', '-am', 'during the session');

  const base = await createGit().compareBase(root, { since });
  assert.equal(base.ref, before);
  assert.equal(base.label, 'session start');
  const changes = await createGit().fileChanges(root, [path.join(root, 'a.txt')], base.ref);
  assert.deepEqual(changes.get(path.join(root, 'a.txt')), { status: 'modified', added: 1, removed: 0 });
});

test('without a start time on main, changes are measured from HEAD', async () => {
  const root = createRepo();
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  assert.deepEqual(await createGit().compareBase(root), { ref: head, label: 'HEAD', description: 'Changes not committed yet' });
});

test('trackedFiles keeps only the files git tracks, taking names literally', async () => {
  const root = createRepo();
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'out.js'), 'built\n');
  fs.writeFileSync(path.join(root, 'weird*.txt'), 'star\n');
  fs.writeFileSync(path.join(root, 'weirdX.txt'), 'not tracked\n');
  git(root, 'add', '.gitignore', 'weird*.txt');
  git(root, 'commit', '-q', '-m', 'more');
  fs.writeFileSync(path.join(root, 'src', 'new.txt'), 'untracked\n');

  const files = ['a.txt', 'weird*.txt', 'weirdX.txt', 'src/new.txt', 'dist/out.js'].map((f) => path.join(root, f));
  const tracked = await createGit().trackedFiles(root, [...files, '/tmp/scratch.txt']);
  assert.deepEqual([...tracked].sort(), [path.join(root, 'a.txt'), path.join(root, 'weird*.txt')].sort());
});
