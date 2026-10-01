'use strict';

// The Claude Code provider: where Claude Code keeps its sessions, what each one is doing, and how to
// open one in the Claude Code extension.

const os = require('os');
const path = require('path');
const { readSessionRecords, normalize } = require('./records');
const { TranscriptIndex, describeTool, resolveTitle } = require('./transcript');

const ID = 'claude-code';

// opener: a ClaudeCodeOpener (./open), or undefined where sessions cannot be opened.
function createClaudeCodeProvider({ configDir, opener } = {}) {
  const dir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sessionsDir = path.join(dir, 'sessions');
  const transcripts = new TranscriptIndex(path.join(dir, 'projects'));

  return {
    id: ID,
    label: 'Claude Code',
    watchDirs: [sessionsDir],

    async listSessions() {
      return (await readSessionRecords(sessionsDir)).map((record) => normalize(record, ID));
    },

    // { title, action, files, branch } from the session's transcript.
    async describe(session) {
      const summary = await transcripts.get(session.raw);
      return {
        title: resolveTitle(session.raw, summary),
        action: summary.lastTool ? describeTool(summary.lastTool) : undefined,
        files: [...summary.files].reverse().map(([file, at]) => ({ path: file, at })),
        // Transcripts say "HEAD" outside a repository.
        branch: summary.gitBranch && summary.gitBranch !== 'HEAD' ? summary.gitBranch : undefined,
      };
    },

    prune(liveIds) {
      transcripts.prune(liveIds);
    },

    canOpen(session) {
      return session.surface === 'editor' && !!opener && opener.available();
    },

    unavailableReason() {
      return 'The Claude Code extension is not installed or is disabled.';
    },

    open(session) {
      return opener.open(session.id);
    },
  };
}

module.exports = { createClaudeCodeProvider, ID };
