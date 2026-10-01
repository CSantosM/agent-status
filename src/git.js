'use strict';

// Git state for session folders. The branch comes from reading .git directly (no process per
// refresh); everything else runs git with a timeout, cached, and only for what the UI shows.
//
// A session's changes are measured from a base commit, so work it already committed still shows:
// on a branch, where it left the default branch (main, master or origin's HEAD); on the default
// branch itself, where HEAD was when the session started (from the reflog); failing both, HEAD.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_MS = 5000;
const TRACKED_CACHE_MS = 15000;
const BASE_CACHE_MS = 15000;
const DEFAULT_BRANCH_CACHE_MS = 60000;
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 32 * 1024 * 1024;

function createGit({
  execFile = childProcess.execFile,
  cacheMs = CACHE_MS,
  trackedCacheMs = TRACKED_CACHE_MS,
  baseCacheMs = BASE_CACHE_MS,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const caches = { repos: new Map(), changes: new Map(), tracked: new Map(), bases: new Map(), defaults: new Map() };

  function run(args) {
    return new Promise((resolve) => {
      // Paths are always literal: a "*" or "?" in a file name is not a wildcard.
      execFile('git', ['--literal-pathspecs', ...args], { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (err, stdout) => {
        // Not a repository, no commits yet, a path outside it: all mean "nothing to report".
        resolve(err ? undefined : stdout);
      });
    });
  }

  async function runText(args) {
    const out = await run(args);
    const text = out ? out.toString('utf8').trim() : '';
    return text || undefined;
  }

  async function cached(cache, key, maxAge, compute) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < maxAge) return hit.value;
    const value = await compute();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  // { root, mainRoot, name, branch, label, worktree } for the repository holding cwd, or undefined.
  // For a linked worktree, root is the worktree and mainRoot the repository it belongs to.
  function repoInfo(cwd) {
    return cached(caches.repos, cwd, cacheMs, () => findRepo(cwd).catch(() => undefined));
  }

  // { ref, name } of the branch work starts from: origin's HEAD, or a local main or master.
  function defaultBranch(root) {
    return cached(caches.defaults, root, DEFAULT_BRANCH_CACHE_MS, async () => {
      const originHead = await runText(['-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      for (const ref of [originHead, 'main', 'master', 'origin/main', 'origin/master']) {
        if (!ref) continue;
        if (await runText(['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) {
          return { ref, name: ref.replace(/^origin\//, '') };
        }
      }
      return undefined;
    });
  }

  // { ref, label, description }: the commit a session's changes are measured from. since is when the
  // session started, in milliseconds.
  function compareBase(root, { since } = {}) {
    const key = `${root}\0${since ? Math.floor(since / 1000) : ''}`;
    return cached(caches.bases, key, baseCacheMs, async () => {
      const [info, main] = await Promise.all([repoInfo(root), defaultBranch(root)]);
      if (info && info.branch && main && info.branch !== main.name) {
        const forkPoint = await runText(['-C', root, 'merge-base', 'HEAD', main.ref]);
        if (forkPoint) {
          return {
            ref: forkPoint,
            label: main.name,
            description: `Changes since ${info.branch} left ${main.name} (${forkPoint.slice(0, 7)})`,
          };
        }
      }
      if (since) {
        const atStart = await runText(['-C', root, 'rev-parse', '--verify', '--quiet', `HEAD@{${gitDate(since)}}`]);
        if (atStart) {
          return { ref: atStart, label: 'session start', description: `Changes since the session started (${atStart.slice(0, 7)})` };
        }
      }
      const head = await runText(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD']);
      return head ? { ref: head, label: 'HEAD', description: 'Changes not committed yet' } : undefined;
    });
  }

  // The files among the given absolute paths that git tracks now, or that the base commit had (so a
  // file the session deleted and committed still counts), as a Set. Paths outside root never do.
  function trackedFiles(root, files, ref) {
    return cached(caches.tracked, `${root}\0${ref || ''}\0${files.join('\0')}`, trackedCacheMs, async () => {
      const relative = relativeTo(root, files);
      const result = new Set();
      if (!relative.size) return result;
      const paths = [...relative.keys()];
      const lists = await Promise.all([
        run(['-C', root, 'ls-files', '-z', '--full-name', '--', ...paths]),
        ref ? run(['-C', root, 'ls-tree', '-r', '-z', '--name-only', '--full-name', ref, '--', ...paths]) : undefined,
      ]);
      for (const out of lists) {
        for (const rel of out ? out.toString('utf8').split('\0') : []) {
          if (relative.has(rel)) result.add(relative.get(rel));
        }
      }
      return result;
    });
  }

  // Map of absolute path -> { status, added, removed }: the working tree against ref (HEAD unless
  // given), so committed and uncommitted changes add up.
  function fileChanges(root, files, ref = 'HEAD') {
    return cached(caches.changes, `${root}\0${ref}\0${files.join('\0')}`, cacheMs, async () => {
      const relative = relativeTo(root, files);
      const result = new Map();
      if (!relative.size) return result;
      const paths = [...relative.keys()];
      const [names, numstat] = await Promise.all([
        run(['-C', root, 'diff', '--name-status', '-z', ref, '--', ...paths]),
        run(['-C', root, 'diff', '--numstat', '-z', ref, '--', ...paths]),
      ]);
      const statuses = parseNameStatus(names);
      const counts = parseNumstat(numstat);
      for (const [rel, file] of relative) {
        const code = statuses.get(rel);
        const count = counts.get(rel);
        result.set(file, {
          status: code === undefined ? (names === undefined ? 'unknown' : 'unchanged') : describeStatus(code),
          added: count ? count.added : undefined,
          removed: count ? count.removed : undefined,
        });
      }
      return result;
    });
  }

  // The file's content at ref (HEAD unless given), or '' when it did not exist or git cannot tell.
  async function contentAt(root, file, ref = 'HEAD') {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return '';
    const out = await run(['-C', root, 'show', `${ref}:${rel}`]);
    return out ? out.toString('utf8') : '';
  }

  return { repoInfo, defaultBranch, compareBase, trackedFiles, fileChanges, contentAt };
}

// Map of path relative to root (with "/") -> absolute path, for the files inside root.
function relativeTo(root, files) {
  const relative = new Map();
  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relative.set(rel.split(path.sep).join('/'), file);
  }
  return relative;
}

// A date git's reflog syntax understands: "2026-10-01 10:00:00 +0000".
function gitDate(ms) {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} +0000`;
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
        mainRoot,
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

// "M\0path\0", and for renames and copies "R100\0old\0new\0"; the new path is the one that matters.
function parseNameStatus(out) {
  const statuses = new Map();
  if (!out) return statuses;
  const fields = out.toString('utf8').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!/^[A-Z]\d*$/.test(code)) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      statuses.set(fields[i + 2], code);
      i += 2;
    } else {
      statuses.set(fields[i + 1], code);
      i += 1;
    }
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
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

module.exports = { createGit, findRepo };
