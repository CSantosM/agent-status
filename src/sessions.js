'use strict';

// Provider-neutral checks on sessions: is the process alive, which VS Code window does it belong to,
// does it come from this machine. Sessions arrive in the shape described in providers/index.js.

const fs = require('fs');

const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc/self/stat');

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

function isAlive(session) {
  if (HAS_PROC) {
    const stat = readProcStat(session.pid);
    // procStart is the process start time, which tells a reused PID apart.
    return !!stat && (session.procStart === undefined || String(session.procStart) === stat.startTime);
  }
  try {
    process.kill(session.pid, 0);
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

// Which window a session belongs to: chats opened by an agent's VS Code extension are child
// processes of that window's extension host (hostPid); CLI sessions descend from one of its
// terminal shells.
function ownership(session, { shellPids, hostPid, inWorkspace }) {
  if (!HAS_PROC) {
    // Without /proc there is no process tree to inspect; sessions in the workspace count as ours.
    return { owned: inWorkspace };
  }
  const lineage = [session.pid, ...ancestors(session.pid)];
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

// Sessions from another machine or PID namespace (a dev container sharing the agent's config, say)
// carry PIDs that mean nothing here. The format is only trusted once a session matches it.
function filterByDomain(sessions, domain) {
  if (!domain || !sessions.some((s) => s.pidDomain === domain)) return sessions;
  return sessions.filter((s) => s.pidDomain === undefined || s.pidDomain === domain);
}

// Two live processes on the same session show as one: this window's first, then the freshest.
function dedupeSessions(sessions) {
  const best = new Map();
  for (const s of sessions) {
    const current = best.get(s.key);
    const better =
      !current ||
      (s.owned && !current.owned) ||
      (s.owned === current.owned && (s.updatedAt || 0) > (current.updatedAt || 0));
    if (better) best.set(s.key, s);
  }
  return [...best.values()];
}

module.exports = { HAS_PROC, isAlive, ancestors, ownership, localPidDomain, filterByDomain, dedupeSessions };
