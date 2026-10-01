'use strict';

// Git state for session folders. The branch comes from reading .git directly (no process per
// refresh); file changes and HEAD contents run git with a timeout, and only when the UI asks.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_MS = 5000;
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 32 * 1024 * 1024;

function createGit({ execFile = childProcess.execFile, cacheMs = CACHE_MS, timeoutMs = TIMEOUT_MS } = {}) {
  const repos = new Map();
  const changes = new Map();

  function run(args) {
    return new Promise((resolve) => {
      execFile('git', args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (err, stdout) => {
        // Not a repository, no commits yet, a path outside it: all mean "nothing to report".
        resolve(err ? undefined : stdout);
      });
    });
  }

  // { root, name, branch, label, worktree } for the repository holding cwd, or undefined.
  async function repoInfo(cwd) {
    const cached = repos.get(cwd);
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    const value = await findRepo(cwd).catch(() => undefined);
    repos.set(cwd, { at: Date.now(), value });
    return value;
  }

  // Map of absolute path -> { status, added, removed } against HEAD, for files inside root.
  async function fileChanges(root, files) {
    const key = `${root}\0${files.join('\0')}`;
    const cached = changes.get(key);
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;

    const relative = new Map();
    for (const file of files) {
      const rel = path.relative(root, file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relative.set(rel.split(path.sep).join('/'), file);
    }
    const result = new Map();
    if (relative.size) {
      const paths = [...relative.keys()];
      const [status, numstat] = await Promise.all([
        run(['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]),
        run(['-C', root, 'diff', '--numstat', '-z', 'HEAD', '--', ...paths]),
      ]);
      const statuses = parseStatus(status);
      const counts = parseNumstat(numstat);
      for (const [rel, file] of relative) {
        const code = statuses.get(rel);
        const count = counts.get(rel);
        result.set(file, {
          status: code === undefined ? (status === undefined ? 'unknown' : 'unchanged') : describeStatus(code),
          added: count ? count.added : undefined,
          removed: count ? count.removed : undefined,
        });
      }
    }
    changes.set(key, { at: Date.now(), value: result });
    return result;
  }

  // The file's content at HEAD, or '' when it is new or git cannot tell.
  async function headContent(root, file) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return '';
    const out = await run(['-C', root, 'show', `HEAD:${rel}`]);
    return out ? out.toString('utf8') : '';
  }

  return { repoInfo, fileChanges, headContent };
}

async function findRepo(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const stat = await fs.promises.stat(dotGit).catch(() => undefined);
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        // Worktrees and submodules point at their git directory: "gitdir: <path>".
        const match = (await fs.promises.readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m);
        if (!match) return undefined;
        gitDir = path.resolve(dir, match[1]);
      }
      const head = (await fs.promises.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      const worktree = stat.isFile() && /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir);
      // A worktree's git directory is <main repository>/.git/worktrees/<name>.
      const mainRoot = worktree ? path.dirname(path.dirname(path.dirname(gitDir))) : dir;
      const branch = ref ? ref[1] : undefined;
      return {
        root: dir,
        name: path.basename(mainRoot),
        branch,
        label: branch || `detached at ${head.slice(0, 7)}`,
        worktree,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseStatus(out) {
  const statuses = new Map();
  if (!out) return statuses;
  const fields = out.toString('utf8').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    statuses.set(entry.slice(3), code);
    if (code[0] === 'R' || code[0] === 'C') i++; // Renames and copies are followed by the old path.
  }
  return statuses;
}

function parseNumstat(out) {
  const counts = new Map();
  if (!out) return counts;
  const fields = out.toString('utf8').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const match = fields[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!match) continue;
    let file = match[3];
    if (file === '' && i + 2 < fields.length) {
      file = fields[i + 2]; // A rename: "added\tremoved\t\0old\0new".
      i += 2;
    }
    counts.set(file, { added: match[1] === '-' ? undefined : Number(match[1]), removed: match[2] === '-' ? undefined : Number(match[2]) });
  }
  return counts;
}

function describeStatus(code) {
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

module.exports = { createGit, findRepo };
