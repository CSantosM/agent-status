'use strict';

// Every agent Agent Status knows about. A provider is an object with:
//
//   id, label            "claude-code", "Claude Code"
//   watchDirs            directories whose changes mean sessions changed (watched, and polled anyway)
//   listSessions()       -> sessions in the provider-neutral shape (see claude-code/records.js):
//                           { provider, id, pid, procStart?, pidDomain?, cwd, status, waitingFor?,
//                             startedAt?, statusUpdatedAt?, updatedAt?, surface, raw }
//                           status is "busy", "waiting" or "idle"; surface is "editor" (a chat in
//                           the agent's own VS Code extension), "cli" (a terminal) or "other".
//   describe(session)    -> { title, action?: { text, icon }, files: [{ path, at }], branch?, resumable }
//                           resumable: the agent can show this session without starting a new one.
//                           Sessions that are not are never opened, and idle ones are hidden.
//   prune(liveIds)       forget sessions that ended
//   canOpen(session), unavailableReason(), open(session)
//                        how an "editor" session is shown in the agent's own chat
//
// To support another agent, add a provider here; the chip, hover, picker, panel and sounds work
// from these fields alone.

const { createClaudeCodeProvider } = require('./claude-code');

function createProviders(options) {
  return [createClaudeCodeProvider(options.claudeCode)];
}

module.exports = { createProviders };
