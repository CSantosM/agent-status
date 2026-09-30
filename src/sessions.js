'use strict';

// Claude Code keeps one record per running session in <config>/sessions/<pid>.json.
// That format is internal to Claude Code, so everything here reads it defensively.

const fs = require('fs');
const path = require('path');

const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc/self/stat');

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

function readProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesised command name, starting at field 3 (state).
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(fields[1]), startTime: fields[19] };
  } catch {
    return undefined;
  }
}

function isAlive(record) {
  if (HAS_PROC) {
    const stat = readProcStat(record.pid);
    // procStart is the process start time, which tells a reused PID apart.
    return !!stat && (record.procStart === undefined || String(record.procStart) === stat.startTime);
  }
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function ancestors(pid) {
  const chain = [];
  let current = pid;
  for (let i = 0; i < 64 && current > 1; i++) {
    const stat = readProcStat(current);
    if (!stat) break;
    current = stat.ppid;
    chain.push(current);
  }
  return chain;
}

// Which window a session belongs to: chats opened by the Claude Code extension are child processes
// of that window's extension host (hostPid); CLI sessions descend from one of its terminal shells.
function ownership(record, { shellPids, hostPid, inWorkspace }) {
  if (!HAS_PROC) {
    // Without /proc there is no process tree to inspect; sessions in the workspace count as ours.
    return { owned: inWorkspace };
  }
  const lineage = [record.pid, ...ancestors(record.pid)];
  const terminalPid = lineage.find((pid) => shellPids.has(pid));
  if (terminalPid !== undefined) return { owned: true, terminalPid };
  return { owned: lineage.includes(hostPid) };
}

// Claude Code tags records with the machine and PID namespace they come from, e.g.
// "linux:<machine-id>:pid:[4026531836]", so the same format is rebuilt here.
function localPidDomain() {
  if (!HAS_PROC) return undefined;
  try {
    const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    return `linux:${machineId}:${fs.readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    return undefined;
  }
}

// Records from another machine or PID namespace (a dev container sharing ~/.claude, say) carry PIDs
// that mean nothing here. The format is Claude Code's, so it is only trusted once a record matches it.
function filterByDomain(records, domain) {
  if (!domain || !records.some((r) => r.pidDomain === domain)) return records;
  return records.filter((r) => r.pidDomain === undefined || r.pidDomain === domain);
}

// Two live processes on the same session show as one dot: this window's first, then the freshest.
function dedupeSessions(sessions) {
  const best = new Map();
  for (const s of sessions) {
    const current = best.get(s.id);
    const better =
      !current ||
      (s.owned && !current.owned) ||
      (s.owned === current.owned && (s.updatedAt || 0) > (current.updatedAt || 0));
    if (better) best.set(s.id, s);
  }
  return [...best.values()];
}

module.exports = {
  HAS_PROC,
  readSessionRecords,
  isValidRecord,
  isAlive,
  ancestors,
  ownership,
  localPidDomain,
  filterByDomain,
  dedupeSessions,
};
