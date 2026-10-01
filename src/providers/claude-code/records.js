'use strict';

// Claude Code keeps one record per running session in <config>/sessions/<pid>.json. That format is
// internal to Claude Code, so it is read defensively and turned into the provider-neutral shape the
// rest of the extension uses.

const fs = require('fs');
const path = require('path');
const { toMillis } = require('../../util');

async function readSessionRecords(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return []; // No sessions directory yet.
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const record = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
          return isValidRecord(record) ? record : undefined;
        } catch {
          return undefined; // Caught mid-write, or removed meanwhile; the next refresh reads it.
        }
      }),
  );
  return records.filter(Boolean);
}

function isValidRecord(record) {
  return (
    !!record &&
    typeof record === 'object' &&
    Number.isInteger(record.pid) &&
    record.pid > 1 &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    typeof record.cwd === 'string' &&
    // "spare" records are pre-warmed processes that no one has claimed yet.
    !record.spare
  );
}

// The provider-neutral session: what every provider hands to the core.
function normalize(record, providerId) {
  return {
    provider: providerId,
    id: record.sessionId,
    pid: record.pid,
    procStart: record.procStart,
    pidDomain: record.pidDomain,
    cwd: record.cwd,
    status: typeof record.status === 'string' ? record.status : undefined,
    waitingFor: typeof record.waitingFor === 'string' ? record.waitingFor : undefined,
    startedAt: toMillis(record.startedAt),
    statusUpdatedAt: toMillis(record.statusUpdatedAt),
    updatedAt: toMillis(record.updatedAt),
    // "editor": a chat opened by the agent's VS Code extension; "cli": a terminal session.
    surface: record.entrypoint === 'claude-vscode' ? 'editor' : record.entrypoint === 'cli' ? 'cli' : 'other',
    raw: record,
  };
}

module.exports = { readSessionRecords, isValidRecord, normalize };
