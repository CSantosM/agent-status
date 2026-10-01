'use strict';

// Showing an existing session in the Claude Code extension. This must never start a new chat:
//   - Only sessions with a transcript are passed in (see "resumable" in the provider). Asked for a
//     chat without messages, Claude Code declines to restore it and opens a new empty chat instead.
//   - The call uses Claude Code's "pin-to-panel" mode. It reveals the session's tab, or the sidebar if
//     the sidebar holds it, or reopens it in a tab from its transcript. The sidebar route ("honor-
//     preferred-location" with the sidebar preferred) is avoided: when Claude Code's sidebar is not
//     open, opening it starts a new empty chat.
// vscode and the extension context are passed in, so the rest of the provider loads without VS Code.

const { withTimeout } = require('../../util');

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const OPEN_TIMEOUT_MS = 10000;
// Versions 0.3 to 0.6 switched claudeCode.preferredLocation to "sidebar" for an instant while opening
// a session, leaving this marker until they put it back.
const PENDING_RESTORE_KEY = 'pendingPreferredLocationRestore';

class ClaudeCodeOpener {
  constructor({ vscode, context, log }) {
    Object.assign(this, { vscode, context, log });
    this.queue = Promise.resolve();
    this.ready = this.restorePendingPreference().catch((err) => log.error(`Restoring preferences: ${err.message}`));
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
    await this.ready;
    const result = await withTimeout(
      this.vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, true, {
        programmatic: 'pin-to-panel',
      }),
      OPEN_TIMEOUT_MS,
    );
    if (result.timedOut) this.log.warn(`Claude Code took over ${OPEN_TIMEOUT_MS / 1000}s to open the session.`);
  }

  // If VS Code stopped while an older version had the preference switched, put the user's value back.
  async restorePendingPreference() {
    const { vscode } = this;
    const pending = this.context.globalState.get(PENDING_RESTORE_KEY);
    if (!pending) return;
    const claude = vscode.workspace.getConfiguration('claudeCode');
    const inspected = claude.inspect('preferredLocation') || {};
    if (inspected.globalValue === 'sidebar' && pending.previous !== 'sidebar') {
      await claude.update('preferredLocation', pending.previous, vscode.ConfigurationTarget.Global);
      this.log.info(`Restored Claude Code's Preferred Location to "${pending.previous ?? 'default'}".`);
    }
    await this.context.globalState.update(PENDING_RESTORE_KEY, undefined);
  }
}

module.exports = { ClaudeCodeOpener, PENDING_RESTORE_KEY };
