'use strict';

// Follows each session's transcript as it grows: <config>/projects/<sanitized cwd>/<sessionId>.jsonl
// plus its subagents' transcripts in <sessionId>/subagents/. It keeps only what the UI needs: the
// titles, the latest tool call of the current turn and the files the session edited. Each update
// reads just the bytes appended since the last one.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const RECHECK_MS = 2000;
const LOCATE_RETRY_MS = 15000;
const FIRST_READ_MAX = 32 * 1024 * 1024; // Read whole transcripts up to this size...
const TAIL_BYTES = 2 * 1024 * 1024; // ...otherwise start this far from the end.
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS_PER_UPDATE = 8;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 200;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

class TranscriptIndex {
  constructor(projectsDir, { recheckMs = RECHECK_MS, firstReadMax = FIRST_READ_MAX, tailBytes = TAIL_BYTES } = {}) {
    Object.assign(this, { projectsDir, recheckMs, firstReadMax, tailBytes });
    this.states = new Map();
  }

  // The summary for a raw session record. Never rejects: a transcript that cannot be read yields
  // what is known so far.
  async get(record) {
    let state = this.states.get(record.sessionId);
    if (!state) {
      state = { summary: emptySummary(), checkedAt: 0, locatedAt: 0, main: undefined, subagents: new Map() };
      this.states.set(record.sessionId, state);
    }
    if (Date.now() - state.checkedAt >= this.recheckMs) {
      if (!state.pending) {
        state.pending = this.update(record, state)
          .catch(() => {})
          .finally(() => {
            state.pending = undefined;
            state.checkedAt = Date.now();
          });
      }
      await state.pending;
    }
    return state.summary;
  }

  prune(liveIds) {
    for (const id of this.states.keys()) {
      if (!liveIds.has(id)) this.states.delete(id);
    }
  }

  async update(record, state) {
    if (!state.main) {
      if (Date.now() - state.locatedAt < LOCATE_RETRY_MS) return;
      state.locatedAt = Date.now();
      const file = await this.locate(record);
      if (!file) return;
      state.main = newCursor(file);
    }
    try {
      await this.follow(state.main, (entry) => apply(entry, state.summary, false), () => {
        state.summary = emptySummary(); // Rewritten from scratch: forget what it said before.
        state.subagents.clear();
      });
    } catch {
      state.main = undefined; // Moved or deleted; locate it again later.
      return;
    }
    await this.followSubagents(record, state);
  }

  async followSubagents(record, state) {
    const dir = path.join(path.dirname(state.main.file), record.sessionId, 'subagents');
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return; // No subagents so far.
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let cursor = state.subagents.get(file);
      if (!cursor) {
        cursor = newCursor(file);
        state.subagents.set(file, cursor);
      }
      try {
        await this.follow(cursor, (entry) => apply(entry, state.summary, true), () => {});
      } catch {
        state.subagents.delete(file);
      }
    }
  }

  async follow(cursor, onEntry, onReset) {
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_UPDATE; chunk++) {
      const stat = await fs.promises.stat(cursor.file);
      if (stat.size < cursor.offset) {
        Object.assign(cursor, newCursor(cursor.file));
        onReset();
      }
      if (stat.size === cursor.offset) return;
      if (cursor.offset === 0 && stat.size > this.firstReadMax) {
        cursor.offset = stat.size - this.tailBytes;
        cursor.skipPartial = true;
      }
      const length = Math.min(stat.size - cursor.offset, CHUNK_BYTES);
      const buffer = Buffer.alloc(length);
      const handle = await fs.promises.open(cursor.file, 'r');
      try {
        await handle.read(buffer, 0, length, cursor.offset);
      } finally {
        await handle.close();
      }
      cursor.offset += length;

      const lines = (cursor.remainder + cursor.decoder.write(buffer)).split('\n');
      cursor.remainder = lines.pop();
      if (cursor.remainder.length > MAX_LINE_BYTES) {
        cursor.remainder = ''; // Give up on a runaway line rather than hold it in memory.
        cursor.skipPartial = true;
      }
      if (cursor.skipPartial && lines.length) {
        lines.shift(); // Starts mid-line.
        cursor.skipPartial = false;
      }
      for (const line of lines) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry && typeof entry === 'object') onEntry(entry);
      }
      if (cursor.offset >= stat.size) return;
    }
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
}

function newCursor(file) {
  return { file, offset: 0, remainder: '', decoder: new StringDecoder('utf8'), skipPartial: false };
}

function emptySummary() {
  return { customTitle: undefined, aiTitle: undefined, gitBranch: undefined, lastTool: undefined, files: new Map() };
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

function apply(entry, summary, fromSubagent) {
  if (!fromSubagent) {
    if (entry.type === 'custom-title') summary.customTitle = text(entry.customTitle) || summary.customTitle;
    else if (entry.type === 'ai-title') summary.aiTitle = text(entry.aiTitle) || summary.aiTitle;
    if (typeof entry.gitBranch === 'string' && entry.gitBranch) summary.gitBranch = entry.gitBranch;
  }
  const content = entry.message && entry.message.content;
  const at = Date.parse(entry.timestamp) || Date.now();
  const sidechain = fromSubagent || entry.isSidechain === true;

  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const part of content) {
      if (!part || part.type !== 'tool_use' || typeof part.name !== 'string') continue;
      const input = part.input && typeof part.input === 'object' ? part.input : {};
      if (!sidechain) summary.lastTool = { name: part.name, input: pickInput(input), at };
      const file = EDIT_TOOLS.has(part.name) ? text(input.file_path) || text(input.notebook_path) : undefined;
      if (file) touch(summary.files, file, at);
    }
  } else if (entry.type === 'user' && !sidechain && !entry.isMeta) {
    // A prompt, not a tool result, starts a new turn: the previous tool call no longer describes it.
    const isToolResult = Array.isArray(content) && content.some((part) => part && part.type === 'tool_result');
    if (!isToolResult) summary.lastTool = undefined;
  }
}

function touch(files, file, at) {
  files.delete(file);
  files.set(file, at);
  if (files.size > MAX_FILES) files.delete(files.keys().next().value);
}

// Only the fields the action text needs, shortened; tool inputs can carry whole files.
function pickInput(input) {
  const picked = {};
  for (const key of ['file_path', 'notebook_path', 'command', 'description', 'pattern', 'query', 'url']) {
    if (typeof input[key] === 'string') picked[key] = input[key].slice(0, 300);
  }
  return picked;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// What a tool call means to a person watching: "Editing auth.ts", "Running: install dependencies".
function describeTool({ name, input }) {
  const base = (file) => (file ? path.basename(file) : undefined);
  const firstLine = (value) => (value ? value.split('\n')[0] : undefined);
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return { text: `Editing ${base(input.file_path) || 'a file'}`, icon: 'edit' };
    case 'Write':
      return { text: `Writing ${base(input.file_path) || 'a file'}`, icon: 'new-file' };
    case 'NotebookEdit':
      return { text: `Editing ${base(input.notebook_path) || 'a notebook'}`, icon: 'notebook' };
    case 'Read':
      return { text: `Reading ${base(input.file_path) || 'a file'}`, icon: 'eye' };
    case 'Bash':
      return {
        text: input.description ? `Running: ${input.description}` : `Running ${firstLine(input.command) || 'a command'}`,
        icon: 'terminal',
      };
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return { text: 'Checking a background command', icon: 'terminal' };
    case 'Grep':
      return { text: input.pattern ? `Searching for "${input.pattern}"` : 'Searching the code', icon: 'search' };
    case 'Glob':
      return { text: input.pattern ? `Finding ${input.pattern}` : 'Finding files', icon: 'search' };
    case 'WebFetch':
      return { text: `Reading ${hostOf(input.url) || 'a web page'}`, icon: 'globe' };
    case 'WebSearch':
      return { text: input.query ? `Searching the web for "${input.query}"` : 'Searching the web', icon: 'globe' };
    case 'Agent':
    case 'Task':
      return { text: input.description ? `Running a subagent: ${input.description}` : 'Running a subagent', icon: 'organization' };
    case 'TodoWrite':
      return { text: 'Updating its to-do list', icon: 'checklist' };
    case 'AskUserQuestion':
      return { text: 'Asking you a question', icon: 'question' };
    case 'ExitPlanMode':
      return { text: 'Presenting a plan', icon: 'checklist' };
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return { text: `Using ${mcp[2]} (${mcp[1]})`, icon: 'plug' };
      return { text: `Using ${name}`, icon: 'tools' };
    }
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function resolveTitle(record, summary) {
  const chosenName = record.nameSource && record.nameSource !== 'derived' ? record.name : undefined;
  const title = chosenName || summary.customTitle || summary.aiTitle || record.name || path.basename(record.cwd);
  return typeof title === 'string' && title.trim() ? title.trim() : record.sessionId.slice(0, 8);
}

module.exports = { TranscriptIndex, describeTool, resolveTitle };
