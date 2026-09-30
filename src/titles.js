'use strict';

// Session titles come from the transcript at <config>/projects/<sanitized cwd>/<sessionId>.jsonl,
// which appends "custom-title" (the tab name you gave it) and "ai-title" entries every so often.

const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 512 * 1024;
const RECHECK_MS = 15000;

class TitleCache {
  constructor(projectsDir, { recheckMs = RECHECK_MS } = {}) {
    this.projectsDir = projectsDir;
    this.recheckMs = recheckMs;
    this.entries = new Map();
    this.pending = new Map();
  }

  // Never rejects: a title that cannot be read falls back to the session's name.
  get(record) {
    const id = record.sessionId;
    const cached = this.entries.get(id);
    if (cached && Date.now() - cached.checkedAt < this.recheckMs) return Promise.resolve(cached);
    let pending = this.pending.get(id);
    if (!pending) {
      pending = this.reload(record, cached).finally(() => this.pending.delete(id));
      this.pending.set(id, pending);
    }
    return pending;
  }

  async reload(record, cached) {
    const entry = { ...cached, checkedAt: Date.now() };
    try {
      entry.file = entry.file || (await this.locate(record));
      if (entry.file) {
        const stat = await fs.promises.stat(entry.file);
        if (stat.mtimeMs !== entry.mtimeMs) {
          Object.assign(entry, await readTitles(entry.file, stat.size));
          entry.mtimeMs = stat.mtimeMs;
        }
      }
    } catch {
      entry.file = undefined; // Moved or deleted; locate it again next time.
    }
    this.entries.set(record.sessionId, entry);
    return entry;
  }

  async locate(record) {
    const name = `${record.sessionId}.jsonl`;
    const direct = path.join(this.projectsDir, record.cwd.replace(/[^a-zA-Z0-9]/g, '-'), name);
    if (await exists(direct)) return direct;
    // Long paths are shortened differently; look through every project folder.
    let dirs = [];
    try {
      dirs = await fs.promises.readdir(this.projectsDir);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const candidate = path.join(this.projectsDir, dir, name);
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }

  prune(liveIds) {
    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) this.entries.delete(id);
    }
  }
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

// Title entries repeat through the transcript, so the tail almost always holds the latest ones.
async function readTitles(file, size) {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(file, 'r');
  try {
    await handle.read(buffer, 0, length, size - length);
  } finally {
    await handle.close();
  }
  const lines = buffer.toString('utf8').split('\n');
  const found = {};
  for (let i = lines.length - 1; i >= 0 && !(found.customTitle && found.aiTitle); i--) {
    const line = lines[i];
    // Real entries start with their type; the same words quoted inside a message are escaped.
    if (!found.customTitle && line.startsWith('{"type":"custom-title"')) {
      const value = titleField(line, 'custom-title', 'customTitle');
      if (value) found.customTitle = value;
    } else if (!found.aiTitle && line.startsWith('{"type":"ai-title"')) {
      const value = titleField(line, 'ai-title', 'aiTitle');
      if (value) found.aiTitle = value;
    }
  }
  return found;
}

function titleField(line, type, key) {
  try {
    const entry = JSON.parse(line);
    const value = entry.type === type ? entry[key] : undefined;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveTitle(record, titles) {
  const chosenName = record.nameSource && record.nameSource !== 'derived' ? record.name : undefined;
  const title = chosenName || titles.customTitle || titles.aiTitle || record.name || path.basename(record.cwd);
  return typeof title === 'string' && title.trim() ? title.trim() : record.sessionId.slice(0, 8);
}

module.exports = { TitleCache, readTitles, resolveTitle };
