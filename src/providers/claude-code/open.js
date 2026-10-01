'use strict';

// Opening a session in the Claude Code extension's chat. vscode and the extension context are passed
// in, so the rest of the provider stays loadable without VS Code.

const { withTimeout } = require('../../util');

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const OPEN_TIMEOUT_MS = 10000;
const BORROW_TIMEOUT_MS = 3000;
const PENDING_RESTORE_KEY = 'pendingPreferredLocationRestore';

class ClaudeCodeOpener {
  // openIn() returns "sidebar" or "preferredLocation" (the agentStatus.openIn setting).
  constructor({ vscode, context, log, logChange, openIn }) {
    Object.assign(this, { vscode, context, log, logChange, openIn });
    this.queue = Promise.resolve();
    this.ready = this.restorePendingPreference().catch((err) => log.error(`Restoring preferences: ${err.message}`));
  }

  available() {
    return !!this.vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  }

  // Serialized so two quick clicks cannot interleave their preference changes.
  open(sessionId) {
    const run = this.queue.then(() => this.reveal(sessionId));
    this.queue = run.catch(() => {});
    return run;
  }

  async reveal(sessionId) {
    const { vscode } = this;
    await this.ready;
    // The same call Claude Code's own session list makes: it reveals the session's tab if it already
    // has one, otherwise opens it where claudeCode.preferredLocation says. Without the "programmatic"
    // option the command always opens a tab and switches that preference to it.
    const open = () =>
      vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, true, {
        programmatic: 'honor-preferred-location',
      });

    const claude = vscode.workspace.getConfiguration('claudeCode');
    const inspected = claude.inspect('preferredLocation') || {};
    const setInWorkspace = inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined;
    const wantSidebar = this.openIn() === 'sidebar';
    if (!wantSidebar || claude.get('preferredLocation') === 'sidebar' || setInWorkspace) {
      if (setInWorkspace && wantSidebar) {
        this.logChange(
          'workspace-pref',
          'warn',
          "Claude Code's Preferred Location is set in this workspace's settings, which this extension never edits; opening sessions where it says.",
        );
      }
      await this.runOpen(open);
      return;
    }
    await this.openInSidebar(open, inspected.globalValue);
  }

  // Claude Code shows a session in its sidebar only when preferredLocation is "sidebar" at the moment
  // of the call (it reads the setting then and does not react to changes). Borrow that value for the
  // call and put the user's back right after, so new chats keep opening where they chose. A marker in
  // globalState lets the next activation put it back if VS Code dies in between.
  async openInSidebar(open, previous) {
    const { vscode } = this;
    const claude = vscode.workspace.getConfiguration('claudeCode');
    try {
      await this.context.globalState.update(PENDING_RESTORE_KEY, { previous });
      await claude.update('preferredLocation', 'sidebar', vscode.ConfigurationTarget.Global);
    } catch (err) {
      await this.context.globalState.update(PENDING_RESTORE_KEY, undefined);
      this.log.warn(`Could not switch Claude Code to its sidebar for this click: ${err.message}`);
      await this.runOpen(open);
      return;
    }
    try {
      // Claude Code has read the setting once the command starts, so a slow command need not keep
      // the user's preference borrowed.
      const result = await withTimeout(open(), BORROW_TIMEOUT_MS);
      if (result.timedOut) this.log.warn(`Claude Code took over ${BORROW_TIMEOUT_MS / 1000}s to open the session.`);
    } finally {
      await this.restorePreference(previous);
    }
  }

  async restorePreference(previous) {
    const { vscode } = this;
    try {
      await vscode.workspace
        .getConfiguration('claudeCode')
        .update('preferredLocation', previous, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(PENDING_RESTORE_KEY, undefined);
    } catch (err) {
      this.log.error(`Could not restore Claude Code's Preferred Location: ${err.stack || err}`);
      const choice = await vscode.window.showErrorMessage(
        `Could not restore Claude Code's Preferred Location to "${previous ?? 'panel'}": ${err.message}`,
        'Open User Settings',
      );
      if (choice) vscode.commands.executeCommand('workbench.action.openSettingsJson');
    }
  }

  async restorePendingPreference() {
    const pending = this.context.globalState.get(PENDING_RESTORE_KEY);
    if (!pending) return;
    const inspected = this.vscode.workspace.getConfiguration('claudeCode').inspect('preferredLocation') || {};
    if (inspected.globalValue === 'sidebar' && pending.previous !== 'sidebar') {
      await this.restorePreference(pending.previous);
      this.log.info(`Restored Claude Code's Preferred Location to "${pending.previous ?? 'default'}" after an interrupted click.`);
    } else {
      await this.context.globalState.update(PENDING_RESTORE_KEY, undefined);
    }
  }

  async runOpen(open) {
    const result = await withTimeout(open(), OPEN_TIMEOUT_MS);
    if (result.timedOut) this.log.warn(`Claude Code took over ${OPEN_TIMEOUT_MS / 1000}s to open the session.`);
  }
}

module.exports = { ClaudeCodeOpener, PENDING_RESTORE_KEY };
