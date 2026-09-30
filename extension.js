'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readSessionRecords,
  isAlive,
  ownership,
  localPidDomain,
  filterByDomain,
  dedupeSessions,
} = require('./src/sessions');
const { TitleCache, resolveTitle } = require('./src/titles');
const { Sound } = require('./src/sound');
const { formatElapsed, plural, truncate, escapeMarkdown, commandLink, toMillis, withTimeout } = require('./src/util');

const CMD = {
  showSessions: 'agentStatus.showSessions',
  filterByStatus: 'agentStatus.filterByStatus',
  refresh: 'agentStatus.refresh',
  testSound: 'agentStatus.testSound',
  showLog: 'agentStatus.showLog',
  open: 'agentStatus.open',
  setFilter: 'agentStatus.setFilter',
};
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

const STATUS = {
  waiting: { label: 'Waiting', rank: 0, color: '#F44336' },
  busy: { label: 'Working', rank: 1, color: '#FBC02D' },
  idle: { label: 'Idle', rank: 2 },
  unknown: { label: 'Unknown', rank: 3 },
};
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'busy', label: 'Working' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'idle', label: 'Idle' },
];
const DEFAULT_DOTS = { busy: '🟡', waiting: '🔴', idle: '🟢', unknown: '⚪' };
const SCOPE_TEXT = { window: 'in this window', workspace: 'in this workspace', all: 'on this machine' };

const TICK_MS = 5000;
const DEBOUNCE_MS = 150;
const REFRESH_STUCK_MS = 15000;
const TERMINAL_PID_TIMEOUT_MS = 1000;
const OPEN_TIMEOUT_MS = 10000;
const BORROW_TIMEOUT_MS = 3000;
const MAX_HOVER_ROWS = 12;
const MAX_TITLE = 80;
const MAX_DETAIL = 140;
const PENDING_RESTORE_KEY = 'pendingPreferredLocationRestore';

function activate(context) {
  const log = vscode.window.createOutputChannel('Agent Status', { log: true });
  context.subscriptions.push(log);
  try {
    new AgentStatus(context, log);
  } catch (err) {
    log.error(`Activation failed: ${err.stack || err}`);
    vscode.window.showErrorMessage(`Agent Status could not start: ${err.message}`);
  }
}

function deactivate() {}

class AgentStatus {
  constructor(context, log) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    this.context = context;
    this.log = log;
    this.sessionsDir = path.join(configDir, 'sessions');
    this.titles = new TitleCache(path.join(configDir, 'projects'));
    this.sound = new Sound({
      builtIn: path.join(context.extensionPath, 'media', 'blip.wav'),
      warn: (message) => vscode.window.showWarningMessage(message),
      log,
    });
    this.pidDomain = localPidDomain();
    this.sessions = [];
    this.lastStatus = new Map();
    this.filter = validFilter(context.globalState.get('filter'));
    this.picker = undefined;
    this.watcher = undefined;
    this.watchedIno = undefined;
    this.debounce = undefined;
    this.inFlight = undefined;
    this.again = false;
    this.opening = Promise.resolve();
    this.rendered = {};
    this.logged = new Map();

    // Lowest priority on the right keeps the chip next to the notifications bell.
    this.item = vscode.window.createStatusBarItem('agentStatus.chip', vscode.StatusBarAlignment.Right, -10000);
    this.item.name = 'Agent Status';
    this.item.command = CMD.showSessions;

    const timer = setInterval(() => this.tick(), TICK_MS);
    context.subscriptions.push(
      this.item,
      {
        dispose: () => {
          clearInterval(timer);
          clearTimeout(this.debounce);
          this.unwatch();
          this.closePicker();
        },
      },
      vscode.commands.registerCommand(CMD.showSessions, () => this.showSessions()),
      vscode.commands.registerCommand(CMD.filterByStatus, () => this.pickFilter(false)),
      vscode.commands.registerCommand(CMD.refresh, () => this.refresh()),
      vscode.commands.registerCommand(CMD.testSound, () => this.sound.play(settings().soundFile, { force: true })),
      vscode.commands.registerCommand(CMD.showLog, () => this.log.show()),
      vscode.commands.registerCommand(CMD.open, (id) => this.open(id)),
      vscode.commands.registerCommand(CMD.setFilter, (key) => this.setFilter(key)),
      vscode.window.onDidOpenTerminal(() => this.schedule()),
      vscode.window.onDidCloseTerminal(() => this.schedule()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentStatus')) this.schedule();
      }),
    );

    this.ready = this.restorePendingPreference().catch((err) => this.log.error(`Restoring preferences: ${err.message}`));
    this.checkWatcher();
    this.refresh();
  }

  // Logs a message only when it differs from the last one under the same key, so a problem that
  // repeats on every refresh is written once.
  logChange(key, level, message) {
    if (this.logged.get(key) === message) return;
    this.logged.set(key, message);
    if (message) this.log[level](message);
  }

  // --- Data -----------------------------------------------------------------

  tick() {
    // The periodic pass also catches crashed sessions (their file stays behind) and a watcher that
    // stopped because the directory was deleted and created again.
    this.checkWatcher();
    this.refresh();
  }

  checkWatcher() {
    let ino;
    try {
      ino = fs.statSync(this.sessionsDir).ino;
    } catch {
      this.unwatch(); // No sessions directory yet; the next tick looks again.
      return;
    }
    if (this.watcher && ino === this.watchedIno) return;
    this.unwatch();
    try {
      this.watcher = fs.watch(this.sessionsDir, () => this.schedule());
      this.watcher.on('error', (err) => {
        this.log.warn(`Watching ${this.sessionsDir} stopped: ${err.message}`);
        this.unwatch();
      });
      this.watchedIno = ino;
    } catch (err) {
      this.logChange('watch', 'warn', `Cannot watch ${this.sessionsDir}: ${err.message}. Refreshing every ${TICK_MS / 1000}s instead.`);
    }
  }

  unwatch() {
    if (!this.watcher) return;
    this.watcher.close();
    this.watcher = undefined;
    this.watchedIno = undefined;
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), DEBOUNCE_MS);
  }

  refresh() {
    if (this.inFlight) {
      if (Date.now() - this.inFlight.startedAt < REFRESH_STUCK_MS) {
        this.again = true;
        return this.inFlight.promise;
      }
      this.log.warn(`A refresh has been running for over ${REFRESH_STUCK_MS / 1000}s; starting a new one.`);
    }
    const run = { startedAt: Date.now() };
    this.inFlight = run;
    run.promise = this.runRefresh(run);
    return run.promise;
  }

  async runRefresh(run) {
    try {
      do {
        this.again = false;
        const sessions = await this.load();
        if (this.inFlight !== run) return; // A newer refresh replaced this stuck one.
        this.sessions = sessions;
        this.announceFinished();
        this.render();
        if (this.picker) this.picker.rebuild();
        this.logChange('refresh', 'error', '');
      } while (this.again);
    } catch (err) {
      this.logChange('refresh', 'error', `Refresh failed: ${err.stack || err}`);
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  async load() {
    const cfg = settings();
    const [records, shells] = await Promise.all([readSessionRecords(this.sessionsDir), terminalShells()]);
    const live = filterByDomain(records, this.pidDomain).filter(isAlive);
    this.titles.prune(new Set(live.map((r) => r.sessionId)));

    const now = Date.now();
    const built = await Promise.all(live.map((r) => this.toSession(r, shells, now)));
    const sessions = dedupeSessions(built).filter(
      (s) => cfg.scope === 'all' || s.owned || (cfg.scope === 'workspace' && s.inWorkspace),
    );
    sessions.sort(cfg.order === 'status' ? byStatus : byStart);
    sessions.forEach((s, i) => {
      s.n = i + 1;
    });
    return sessions;
  }

  async toSession(record, shells, now) {
    const status = Object.hasOwn(STATUS, record.status) ? record.status : 'unknown';
    const inWorkspace = workspaceFolderOf(record.cwd) !== undefined;
    const { owned, terminalPid } = ownership(record, { shellPids: shells, hostPid: process.pid, inWorkspace });
    const statusSince = toMillis(record.statusUpdatedAt) || toMillis(record.updatedAt) || toMillis(record.startedAt) || now;
    return {
      id: record.sessionId,
      pid: record.pid,
      title: resolveTitle(record, await this.titles.get(record)),
      folder: folderLabel(record.cwd),
      inWorkspace,
      status,
      statusLabel: status === 'unknown' && record.status ? truncate(String(record.status), 20) : STATUS[status].label,
      waitingFor: status === 'waiting' && typeof record.waitingFor === 'string' ? record.waitingFor : undefined,
      since: now - statusSince,
      startedAt: toMillis(record.startedAt) || 0,
      updatedAt: toMillis(record.updatedAt) || statusSince,
      entrypoint: record.entrypoint,
      owned,
      terminal: terminalPid === undefined ? undefined : shells.get(terminalPid),
    };
  }

  visible() {
    return this.sessions.filter((s) => this.filter === 'all' || s.status === this.filter);
  }

  // A session finished its turn when it goes from working to idle between two refreshes. Only this
  // window's sessions count, so several open windows do not all blip for the same session.
  announceFinished() {
    const cfg = settings();
    const finished = this.sessions.some((s) => s.owned && s.status === 'idle' && this.lastStatus.get(s.id) === 'busy');
    this.lastStatus = new Map(this.sessions.map((s) => [s.id, s.status]));
    if (finished && cfg.soundOnFinish) this.sound.play(cfg.soundFile);
  }

  // --- Status bar chip and hover --------------------------------------------

  render() {
    const cfg = settings();
    const all = this.sessions;
    const visible = this.visible();
    if (!all.length && cfg.hideWhenEmpty) {
      this.item.hide();
      this.rendered.visible = false;
      return;
    }

    const shown = visible.slice(0, cfg.maxDots);
    let text = `$(${cfg.icon})`;
    if (shown.length) text += ' ' + shown.map((s) => cfg.dots[s.status]).join('');
    if (visible.length > shown.length) text += ` +${visible.length - shown.length}`;
    if (this.filter !== 'all') text += ' $(filter)';
    const color = !all.length ? 'disabled' : (cfg.iconReflectsStatus && urgentColor(all)) || '';
    const tooltip = this.tooltip(all, visible, cfg);

    // Only touch what changed: reassigning the tooltip redraws a hover the user may be reading.
    if (text !== this.rendered.text) this.item.text = this.rendered.text = text;
    if (color !== this.rendered.color) {
      this.item.color = color === 'disabled' ? new vscode.ThemeColor('disabledForeground') : color || undefined;
      this.rendered.color = color;
    }
    if (tooltip !== this.rendered.tooltip) {
      const md = new vscode.MarkdownString(tooltip);
      md.supportThemeIcons = true;
      md.isTrusted = { enabledCommands: [CMD.open, CMD.setFilter, CMD.showSessions] };
      this.item.tooltip = md;
      this.rendered.tooltip = tooltip;
    }
    this.item.accessibilityInformation = { label: accessibleSummary(all), role: 'button' };
    if (!this.rendered.visible) {
      this.item.show();
      this.rendered.visible = true;
    }
  }

  tooltip(all, visible, cfg) {
    const where = SCOPE_TEXT[cfg.scope];
    if (!all.length) return `**Claude Code** · no sessions running ${where}`;

    let header = `**Claude Code** · ${plural(all.length, 'session')} ${where}`;
    if (this.filter !== 'all') header += ` · showing ${visible.length}`;

    const filters = FILTERS.map((f) => {
      const text = `${f.label} (${countFor(all, f.key)})`;
      return f.key === this.filter
        ? `**${text}**`
        : commandLink(text, CMD.setFilter, [f.key], `Show ${f.label.toLowerCase()} sessions`);
    }).join(' · ');

    let rows = visible.length
      ? visible
          .slice(0, MAX_HOVER_ROWS)
          .map((s) => this.hoverRow(s, cfg))
          .join('\n\n')
      : '_No sessions with this status._';
    if (visible.length > MAX_HOVER_ROWS) {
      rows += `\n\n_…and ${visible.length - MAX_HOVER_ROWS} more in the_ ${commandLink('session picker', CMD.showSessions)}`;
    }

    const footer = `${commandLink('$(list-selection) Open session picker', CMD.showSessions)} · or click the chip`;
    return [header, `Filter: ${filters}`, '---', rows, '---', footer].join('\n\n');
  }

  hoverRow(s, cfg) {
    const title = escapeMarkdown(truncate(s.title, MAX_TITLE));
    const lines = [
      `${cfg.dots[s.status]} \`${s.n}\` ${commandLink(title, CMD.open, [s.id], 'Open this session')}`,
      escapeMarkdown(describe(s)),
    ];
    if (s.waitingFor) lines.push(`_${escapeMarkdown(truncate(s.waitingFor, MAX_DETAIL))}_`);
    return lines.join('  \n');
  }

  // --- Session picker -------------------------------------------------------

  showSessions() {
    if (this.picker) {
      this.picker.qp.show();
      return;
    }
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search by title, folder or status';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    const rebuild = () => {
      const cfg = settings();
      const filtered = this.filter !== 'all';
      qp.title = 'Claude Code Sessions' + (filtered ? ` · ${filterLabel(this.filter)}` : '');
      qp.buttons = [{ iconPath: new vscode.ThemeIcon(filtered ? 'filter-filled' : 'filter'), tooltip: 'Filter by status' }];

      const previous = qp.activeItems[0] && qp.activeItems[0].session.id;
      const items = this.visible().map((s) => ({
        label: `${cfg.dots[s.status]} ${s.n}  ${truncate(s.title, MAX_TITLE)}`,
        description: `${s.statusLabel} · ${formatElapsed(s.since)}`,
        detail: [s.waitingFor && truncate(s.waitingFor, MAX_DETAIL), s.folder, whereElse(s)].filter(Boolean).join(' · '),
        session: s,
      }));
      qp.items = items;
      // Keep the highlighted row across live updates; otherwise start on the first session that needs you.
      const active =
        items.find((i) => i.session.id === previous) || items.find((i) => i.session.status === 'waiting') || items[0];
      if (active) qp.activeItems = [active];
    };

    qp.onDidTriggerButton(() => {
      this.closePicker();
      this.pickFilter(true);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] || qp.activeItems[0];
      this.closePicker();
      if (item) this.open(item.session.id);
    });
    qp.onDidHide(() => this.closePicker());

    this.picker = { qp, rebuild };
    rebuild();
    qp.show();
  }

  closePicker() {
    if (!this.picker) return;
    const { qp } = this.picker;
    this.picker = undefined;
    qp.hide();
    qp.dispose();
  }

  pickFilter(fromSessionPicker) {
    const cfg = settings();
    const qp = vscode.window.createQuickPick();
    qp.title = 'Filter by Status';
    qp.placeholder = 'Choose which sessions the chip shows';
    if (fromSessionPicker) qp.buttons = [vscode.QuickInputButtons.Back];

    const items = FILTERS.map((f) => ({
      label: `${f.key === this.filter ? '$(check)' : '$(blank)'} ${f.key === 'all' ? '$(blank)' : cfg.dots[f.key]} ${f.label}`,
      description: plural(countFor(this.sessions, f.key), 'session'),
      key: f.key,
    }));
    qp.items = items;
    qp.activeItems = items.filter((i) => i.key === this.filter);

    let backToSessions = false;
    qp.onDidTriggerButton(() => {
      backToSessions = true;
      qp.hide();
    });
    qp.onDidAccept(() => {
      const item = qp.activeItems[0];
      if (item) this.setFilter(item.key);
      backToSessions = fromSessionPicker;
      qp.hide();
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (backToSessions) this.showSessions();
    });
    qp.show();
  }

  setFilter(key) {
    if (!FILTERS.some((f) => f.key === key)) return;
    this.filter = key;
    this.context.globalState.update('filter', key);
    this.render();
    if (this.picker) this.picker.rebuild();
  }

  // --- Opening --------------------------------------------------------------

  async open(id) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) {
      vscode.window.showWarningMessage('That Claude Code session is no longer running.');
      return;
    }
    if (s.terminal) {
      s.terminal.show();
      return;
    }
    // Opening a session that runs somewhere else would attach a second client to it.
    if (!s.owned) {
      vscode.window.showInformationMessage(`"${truncate(s.title, MAX_TITLE)}" is running in ${whereElse(s)}. Switch there to open it.`);
      return;
    }
    if (s.entrypoint !== 'claude-vscode') {
      vscode.window.showInformationMessage(`"${truncate(s.title, MAX_TITLE)}" is not attached to a chat or a terminal in this window.`);
      return;
    }
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
      vscode.window.showWarningMessage('The Claude Code extension is not installed or is disabled.');
      return;
    }
    try {
      await this.showInClaude(s.id);
    } catch (err) {
      this.log.error(`Opening session ${s.id}: ${err.stack || err}`);
      vscode.window.showErrorMessage(`Could not open the session: ${err.message}`);
    }
  }

  // Serialized so two quick clicks cannot interleave their preference changes.
  showInClaude(id) {
    const run = this.opening.then(() => this.revealInClaude(id));
    this.opening = run.catch(() => {});
    return run;
  }

  async revealInClaude(id) {
    await this.ready;
    // The same call Claude Code's own session list makes: it reveals the session's tab if it already
    // has one, otherwise opens it where claudeCode.preferredLocation says. Without the "programmatic"
    // option the command always opens a tab and switches that preference to it.
    const open = () =>
      vscode.commands.executeCommand('claude-vscode.editor.open', id, undefined, undefined, undefined, true, {
        programmatic: 'honor-preferred-location',
      });

    const claude = vscode.workspace.getConfiguration('claudeCode');
    const inspected = claude.inspect('preferredLocation') || {};
    const setInWorkspace = inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined;
    if (settings().openIn !== 'sidebar' || claude.get('preferredLocation') === 'sidebar' || setInWorkspace) {
      if (setInWorkspace && settings().openIn === 'sidebar') {
        this.logChange('workspace-pref', 'warn', "Claude Code's Preferred Location is set in this workspace's settings, which this extension never edits; opening sessions where it says.");
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
    const inspected = vscode.workspace.getConfiguration('claudeCode').inspect('preferredLocation') || {};
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

// --- VS Code helpers ------------------------------------------------------------

async function terminalShells() {
  const shells = new Map();
  await Promise.all(
    vscode.window.terminals.map(async (terminal) => {
      try {
        // A terminal whose process never starts would otherwise hold up every refresh.
        const result = await withTimeout(terminal.processId, TERMINAL_PID_TIMEOUT_MS);
        if (result.value) shells.set(result.value, terminal);
      } catch {
        // Terminal closed while we asked.
      }
    }),
  );
  return shells;
}

function settings() {
  const c = vscode.workspace.getConfiguration('agentStatus');
  const oneOf = (key, allowed) => (allowed.includes(c.get(key)) ? c.get(key) : allowed[0]);
  const icon = c.get('icon');
  const maxDots = Number(c.get('maxDots'));
  const dots = { ...DEFAULT_DOTS };
  const custom = c.get('dots');
  if (custom && typeof custom === 'object') {
    for (const key of ['busy', 'waiting', 'idle']) {
      if (typeof custom[key] === 'string' && custom[key].trim()) dots[key] = truncate(custom[key].trim(), 4);
    }
  }
  let soundFile = typeof c.get('soundFile') === 'string' ? c.get('soundFile').trim() : '';
  if (soundFile.startsWith('~/')) soundFile = path.join(os.homedir(), soundFile.slice(2));
  return {
    scope: oneOf('scope', ['window', 'workspace', 'all']),
    order: oneOf('order', ['stable', 'status']),
    openIn: oneOf('openIn', ['sidebar', 'preferredLocation']),
    icon: typeof icon === 'string' && /^[a-z0-9-]+$/.test(icon) ? icon : 'robot',
    iconReflectsStatus: c.get('iconReflectsStatus') !== false,
    maxDots: Number.isInteger(maxDots) ? Math.min(50, Math.max(1, maxDots)) : 8,
    hideWhenEmpty: c.get('hideWhenEmpty') === true,
    soundOnFinish: c.get('soundOnFinish') !== false,
    soundFile,
    dots,
  };
}

function workspaceFolderOf(cwd) {
  return (vscode.workspace.workspaceFolders || []).find(
    (f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep),
  );
}

function folderLabel(cwd) {
  const folder = workspaceFolderOf(cwd);
  if (folder) {
    const relative = path.relative(folder.uri.fsPath, cwd);
    const worktree = relative.match(/^\.claude[\\/]worktrees[\\/](.+)$/);
    if (worktree) return `${folder.name} (worktree ${worktree[1]})`;
    return relative ? `${folder.name}/${relative}` : folder.name;
  }
  const home = os.homedir();
  return cwd.startsWith(home + path.sep) ? `~${cwd.slice(home.length)}` : cwd;
}

// --- Formatting -----------------------------------------------------------------

function byStart(a, b) {
  return a.startedAt - b.startedAt || a.pid - b.pid;
}

function byStatus(a, b) {
  return STATUS[a.status].rank - STATUS[b.status].rank || byStart(a, b);
}

function whereElse(s) {
  if (s.owned) return undefined;
  return s.entrypoint === 'claude-vscode' ? 'another VS Code window' : 'a terminal outside VS Code';
}

function describe(s) {
  const parts = [s.statusLabel, formatElapsed(s.since), s.folder];
  if (s.terminal) parts.push('terminal');
  const elsewhere = whereElse(s);
  if (elsewhere) parts.push(elsewhere);
  return parts.join(' · ');
}

function urgentColor(sessions) {
  if (sessions.some((s) => s.status === 'waiting')) return STATUS.waiting.color;
  if (sessions.some((s) => s.status === 'busy')) return STATUS.busy.color;
  return undefined;
}

function accessibleSummary(sessions) {
  if (!sessions.length) return 'Claude Code: no sessions';
  const parts = FILTERS.filter((f) => f.key !== 'all')
    .map((f) => `${countFor(sessions, f.key)} ${f.label.toLowerCase()}`)
    .join(', ');
  return `Claude Code sessions: ${parts}`;
}

function countFor(sessions, key) {
  return key === 'all' ? sessions.length : sessions.filter((s) => s.status === key).length;
}

function validFilter(key) {
  return FILTERS.some((f) => f.key === key) ? key : 'all';
}

function filterLabel(key) {
  return FILTERS.find((f) => f.key === key).label;
}

module.exports = { activate, deactivate };
