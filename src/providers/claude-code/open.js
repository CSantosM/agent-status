'use strict';

// Showing an existing session in the Claude Code extension. This must never start a new chat:
//   - Only sessions with a transcript are passed in (see "resumable" in the provider). Asked for a
//     chat without messages, Claude Code declines to restore it and opens a new empty chat instead.
//   - The call uses Claude Code's "pin-to-panel" mode. It reveals the session's tab, or the sidebar if
//     the sidebar holds it, or reopens it in a tab from its transcript. The sidebar route ("honor-
//     preferred-location" with the sidebar preferred) is avoided: when Claude Code's sidebar is not
//     open, opening it starts a new empty chat.
// vscode is passed in, so the rest of the provider loads without VS Code.

const { withTimeout } = require('../../util');

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const OPEN_TIMEOUT_MS = 10000;

class ClaudeCodeOpener {
  constructor({ vscode, log }) {
    Object.assign(this, { vscode, log });
    this.queue = Promise.resolve();
  }

  available() {
    return !!this.vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  }

  // One at a time, so quick clicks cannot pile up panels.
  open(sessionId) {
    const run = this.queue.then(() => this.reveal(sessionId));
    this.queue = run.catch(() => {});
    return run;
  }

  async reveal(sessionId) {
    const result = await withTimeout(
      this.vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, true, {
        programmatic: 'pin-to-panel',
      }),
      OPEN_TIMEOUT_MS,
    );
    if (result.timedOut) this.log.warn(`Claude Code took over ${OPEN_TIMEOUT_MS / 1000}s to open the session.`);
  }
}

module.exports = { ClaudeCodeOpener };
