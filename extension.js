'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isAlive, ownership, localPidDomain, filterByDomain, dedupeSessions } = require('./src/sessions');
const { createProviders } = require('./src/providers');
const { ClaudeCodeOpener } = require('./src/providers/claude-code/open');
const { createGit } = require('./src/git');
const { SessionsPanel } = require('./src/panel');
const { Sound } = require('./src/sound');
const { formatElapsed, plural, truncate, escapeMarkdown, commandLink, withTimeout } = require('./src/util');

const CMD = {
  showSessions: 'agentStatus.showSessions',
  filterByStatus: 'agentStatus.filterByStatus',
  refresh: 'agentStatus.refresh',
  playFinishSound: 'agentStatus.playFinishSound',
  playWaitingSound: 'agentStatus.playWaitingSound',
  showLog: 'agentStatus.showLog',
  open: 'agentStatus.open',
  setFilter: 'agentStatus.setFilter',
  openFileDiff: 'agentStatus.openFileDiff',
  openFile: 'agentStatus.openFile',
  groupByBranch: 'agentStatus.groupByBranch',
  ungroup: 'agentStatus.ungroup',
};
const VIEW_ID = 'agentStatus.sessions';
// Documents with a file's content at a commit, for the left side of a diff.
const BASE_SCHEME = 'agent-status-base';

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
const DESCRIBE_TIMEOUT_MS = 3000;
const MAX_HOVER_ROWS = 12;
const MAX_TITLE = 80;
const MAX_DETAIL = 140;
const MAX_NOTIFICATIONS = 3;

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
    this.context = context;
    this.log = log;
    this.logged = new Map();

    this.claudeOpener = new ClaudeCodeOpener({ vscode, context, log });
    this.providers = createProviders({ claudeCode: { opener: this.claudeOpener } });
    this.git = createGit();
    this.sound = new Sound({
      builtIns: {
        finish: path.join(context.extensionPath, 'media', 'finish.wav'),
        waiting: path.join(context.extensionPath, 'media', 'waiting.wav'),
      },
      warn: (message) => vscode.window.showWarningMessage(message),
      log,
    });
    this.pidDomain = localPidDomain();
    this.sessions = [];
    this.lastStatus = new Map();
    this.filter = validFilter(context.globalState.get('filter'));
    this.picker = undefined;
    this.watchers = new Map();
    this.debounce = undefined;
    this.inFlight = undefined;
    this.again = false;
    this.rendered = {};

    // Lowest priority on the right keeps the chip next to the notifications bell.
    this.item = vscode.window.createStatusBarItem('agentStatus.chip', vscode.StatusBarAlignment.Right, -10000);
    this.item.name = 'Agent Status';
    this.item.command = CMD.showSessions;

    this.panel = new SessionsPanel({
      visible: () => this.visible(),
      settings,
      git: this.git,
      whereElse,
      activity,
    });
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.panel, showCollapseAll: true });

    const timer = setInterval(() => this.tick(), TICK_MS);
    context.subscriptions.push(
      this.item,
      this.view,
      this.panel,
      {
        dispose: () => {
          clearInterval(timer);
          clearTimeout(this.debounce);
          for (const dir of [...this.watchers.keys()]) this.unwatch(dir);
          this.closePicker();
        },
      },
      vscode.commands.registerCommand(CMD.showSessions, () => this.showSessions()),
      vscode.commands.registerCommand(CMD.filterByStatus, () => this.pickFilter(false)),
      vscode.commands.registerCommand(CMD.refresh, () => this.refresh()),
      vscode.commands.registerCommand(CMD.playFinishSound, () =>
        this.sound.play('finish', settings().finishSoundFile, { force: true }),
      ),
      vscode.commands.registerCommand(CMD.playWaitingSound, () =>
        this.sound.play('waiting', settings().waitingSoundFile, { force: true }),
      ),
      vscode.commands.registerCommand(CMD.showLog, () => this.log.show()),
      vscode.commands.registerCommand(CMD.open, (target) => this.open(target)),
      vscode.commands.registerCommand(CMD.setFilter, (key) => this.setFilter(key)),
      vscode.commands.registerCommand(CMD.openFileDiff, (target, file) => this.openFileDiff(target, file)),
      vscode.commands.registerCommand(CMD.openFile, (target, file) => this.openFile(target, file)),
      vscode.commands.registerCommand(CMD.groupByBranch, () => setGroupBy('branch')),
      vscode.commands.registerCommand(CMD.ungroup, () => setGroupBy('none')),
      vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
        provideTextDocumentContent: (uri) => {
          const query = new URLSearchParams(uri.query);
          return this.git.contentAt(query.get('root'), uri.fsPath, query.get('ref') || 'HEAD');
        },
      }),
      vscode.window.onDidOpenTerminal(() => this.schedule()),
      vscode.window.onDidCloseTerminal(() => this.schedule()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentStatus')) this.schedule();
      }),
    );

    this.checkWatchers();
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
    // The periodic pass also catches crashed sessions (their record stays behind), transcripts that
    // grew, and a watcher that stopped because its directory was deleted and created again.
    this.checkWatchers();
    this.refresh();
  }

  checkWatchers() {
    for (const dir of this.providers.flatMap((p) => p.watchDirs)) this.checkWatcher(dir);
  }

  checkWatcher(dir) {
    let ino;
    try {
      ino = fs.statSync(dir).ino;
    } catch {
      this.unwatch(dir); // Not there yet; the next tick looks again.
      return;
    }
    const current = this.watchers.get(dir);
    if (current && current.ino === ino) return;
    this.unwatch(dir);
    try {
      const watcher = fs.watch(dir, () => this.schedule());
      watcher.on('error', (err) => {
        this.log.warn(`Watching ${dir} stopped: ${err.message}`);
        this.unwatch(dir);
      });
      this.watchers.set(dir, { watcher, ino });
    } catch (err) {
      this.logChange(`watch:${dir}`, 'warn', `Cannot watch ${dir}: ${err.message}. Refreshing every ${TICK_MS / 1000}s instead.`);
    }
  }

  unwatch(dir) {
    const current = this.watchers.get(dir);
    if (!current) return;
    current.watcher.close();
    this.watchers.delete(dir);
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
        this.announceTransitions();
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
    const [lists, shells] = await Promise.all([Promise.all(this.providers.map((p) => this.listFrom(p))), terminalShells()]);
    const live = filterByDomain(lists.flat(), this.pidDomain).filter(isAlive);
    for (const provider of this.providers) {
      provider.prune(new Set(live.filter((s) => s.provider === provider.id).map((s) => s.id)));
    }
    const now = Date.now();
    const built = await Promise.all(live.map((s) => this.toSession(s, shells, now)));
    const sessions = dedupeSessions(built).filter(
      (s) =>
        (cfg.scope === 'all' || s.owned || (cfg.scope === 'workspace' && s.inWorkspace)) &&
        // An idle chat without messages is not an agent at work, and cannot be opened.
        (cfg.showEmptySessions || !(s.empty && s.status === 'idle')),
    );
    return arrange(sessions, cfg);
  }

  async listFrom(provider) {
    try {
      const sessions = await provider.listSessions();
      this.logChange(`list:${provider.id}`, 'error', '');
      return sessions;
    } catch (err) {
      this.logChange(`list:${provider.id}`, 'error', `${provider.label}: could not list sessions: ${err.message}`);
      return [];
    }
  }

  async describe(provider, record) {
    try {
      const result = await withTimeout(provider.describe(record), DESCRIBE_TIMEOUT_MS);
      if (result.timedOut) {
        this.logChange(`describe:${provider.id}`, 'warn', `${provider.label}: reading session details took over ${DESCRIBE_TIMEOUT_MS / 1000}s.`);
        return {};
      }
      return result.value || {};
    } catch (err) {
      this.logChange(`describe:${provider.id}`, 'error', `${provider.label}: could not read session details: ${err.message}`);
      return {};
    }
  }

  async toSession(record, shells, now) {
    const provider = this.providers.find((p) => p.id === record.provider);
    const status = Object.hasOwn(STATUS, record.status) ? record.status : 'unknown';
    const inWorkspace = workspaceFolderOf(record.cwd) !== undefined;
    const { owned, terminalPid } = ownership(record, { shellPids: shells, hostPid: process.pid, inWorkspace });
    const [details, repo] = await Promise.all([this.describe(provider, record), this.git.repoInfo(record.cwd)]);
    const files = await this.relevantFiles(details.files, record.startedAt);
    const statusSince = record.statusUpdatedAt || record.updatedAt || record.startedAt || now;
    const action = details.action && typeof details.action.text === 'string' ? details.action : undefined;
    return {
      key: `${record.provider}:${record.id}`,
      id: record.id,
      providerId: provider.id,
      providerLabel: provider.label,
      pid: record.pid,
      cwd: record.cwd,
      title: details.title || path.basename(record.cwd) || record.id.slice(0, 8),
      action: action && { text: action.text, icon: /^[a-z0-9-]+(~spin)?$/.test(action.icon) ? action.icon : 'tools' },
      files,
      repo,
      branchLabel: repo ? repo.label : details.branch,
      folder: folderLabel(record.cwd),
      inWorkspace,
      status,
      statusLabel: status === 'unknown' && record.status ? truncate(String(record.status), 20) : STATUS[status].label,
      waitingFor: status === 'waiting' ? record.waitingFor : undefined,
      since: now - statusSince,
      startedAt: record.startedAt || 0,
      updatedAt: record.updatedAt || statusSince,
      surface: record.surface,
      owned,
      terminal: terminalPid === undefined ? undefined : shells.get(terminalPid),
      // Only a session the agent can restore is ever handed to it; anything else would start a new chat.
      resumable: details.resumable === true,
      empty: details.resumable === false,
      openable: terminalPid !== undefined || (owned && details.resumable === true && provider.canOpen(record)),
    };
  }

  // Only the files inside the workspace open in VS Code, or inside a worktree of one of its
  // repositories wherever it is (agents often work in worktrees under /tmp): an agent's scratch files
  // and anything else outside say nothing about the work there. Inside a git repository a file must
  // also be tracked, which leaves out ignored and build files; outside one, every edited file counts. Each file is checked against the repository it lives in, which need not be the session's,
  // and keeps that root, the commit its changes are measured from (so work already committed still
  // shows; see compareBase in src/git.js) and its workspace folder (to show where it is).
  async relevantFiles(files, startedAt) {
    if (!Array.isArray(files) || !files.length) return [];
    try {
      const relevant = [];
      const byRoot = new Map();
      const workspaceRepos = await this.workspaceRepositories();
      for (const [index, file] of files.entries()) {
        if (!file || typeof file.path !== 'string') continue;
        const folder = workspaceFolderOf(file.path);
        const repo = await this.git.repoInfo(path.dirname(file.path));
        const inWorktree = !folder && !!repo && workspaceRepos.has(repo.mainRoot);
        if (!folder && !inWorktree) continue;
        const entry = {
          index,
          file: {
            ...file,
            root: repo && repo.root,
            folder: folder ? folder.uri.fsPath : repo.root,
            worktree: inWorktree ? repo.label : undefined, // The worktree's branch, to tell where the file is.
          },
        };
        if (!repo) {
          relevant.push(entry);
          continue;
        }
        if (!byRoot.has(repo.root)) byRoot.set(repo.root, []);
        byRoot.get(repo.root).push(entry);
      }
      for (const [root, entries] of byRoot) {
        const compare = await this.git.compareBase(root, { since: startedAt });
        const tracked = await this.git.trackedFiles(root, entries.map((e) => e.file.path), compare && compare.ref);
        for (const e of entries) {
          if (tracked.has(e.file.path)) relevant.push({ ...e, file: { ...e.file, compare } });
        }
      }
      return relevant.sort((a, b) => a.index - b.index).map((e) => e.file); // Most recent first, as given.
    } catch (err) {
      this.logChange('tracked', 'warn', `Could not ask git which files it tracks: ${err.message}`);
      return [];
    }
  }

  // The repositories the workspace folders belong to (their main repository, for a worktree).
  async workspaceRepositories() {
    const repos = await Promise.all((vscode.workspace.workspaceFolders || []).map((f) => this.git.repoInfo(f.uri.fsPath)));
    return new Set(repos.filter(Boolean).map((r) => r.mainRoot));
  }

  visible() {
    return this.sessions.filter((s) => this.filter === 'all' || s.status === this.filter);
  }

  // Between two refreshes, a working session that turns idle finished its turn, and one that turns
  // waiting stopped for your decision. Only this window's sessions count, so several open windows do
  // not all react to the same session.
  announceTransitions() {
    const cfg = settings();
    const changedTo = (status) =>
      this.sessions.filter((s) => s.owned && s.status === status && this.lastStatus.get(s.key) === 'busy');
    const waiting = changedTo('waiting');
    const finished = changedTo('idle');
    this.lastStatus = new Map(this.sessions.map((s) => [s.key, s.status]));
    // One sound at a time; a session that needs you outranks one that finished.
    if (waiting.length && cfg.soundOnWaiting) this.sound.play('waiting', cfg.waitingSoundFile);
    else if (finished.length && cfg.soundOnFinish) this.sound.play('finish', cfg.finishSoundFile);
    if (cfg.notifyOnWaiting) waiting.slice(0, MAX_NOTIFICATIONS).forEach((s) => this.notifyWaiting(s));
  }

  async notifyWaiting(s) {
    const detail = s.waitingFor ? `: ${truncate(s.waitingFor, MAX_DETAIL)}` : '.';
    const choice = await vscode.window.showInformationMessage(
      `"${truncate(s.title, MAX_TITLE)}" needs your decision${detail}`,
      'Open',
      'Turn Off',
    );
    if (choice === 'Open') this.open(s.key);
    if (choice === 'Turn Off') {
      vscode.workspace.getConfiguration('agentStatus').update('notifyOnWaiting', false, vscode.ConfigurationTarget.Global);
    }
  }

  // --- Status bar chip, hover and panel ---------------------------------------

  render() {
    const cfg = settings();
    const all = this.sessions;
    const visible = this.visible();
    this.renderView(all);
    if (!all.length && cfg.hideWhenEmpty) {
      this.item.hide();
      this.rendered.visible = false;
      return;
    }

    const shown = visible.slice(0, cfg.maxDots);
    let dots = '';
    shown.forEach((s, i) => {
      if (cfg.groupBy === 'branch' && i > 0 && s.group.key !== shown[i - 1].group.key) dots += ' · ';
      dots += cfg.dots[s.status];
    });
    // Like the Source Control count of changes: how many agents are working right now.
    const working = countFor(all, 'busy');
    let text = `$(${cfg.icon})`;
    if (!all.length) text += ` ${vscode.l10n.t('No agents')}`;
    if (working) text += ` ${working}`;
    if (dots) text += ` ${dots}`;
    if (visible.length > shown.length) text += ` +${visible.length - shown.length}`;
    if (this.filter !== 'all') text += ' $(filter)';
    // With no sessions the chip keeps the status bar's own color, so it stays easy to find.
    const color = (cfg.iconReflectsStatus && urgentColor(all)) || '';
    const tooltip = this.tooltip(all, visible, cfg);

    // Only touch what changed: reassigning the tooltip redraws a hover the user may be reading.
    if (text !== this.rendered.text) this.item.text = this.rendered.text = text;
    if (color !== this.rendered.color) {
      this.item.color = color || undefined;
      this.rendered.color = color;
    }
    if (tooltip !== this.rendered.tooltip) {
      const md = new vscode.MarkdownString(tooltip);
      md.supportThemeIcons = true;
      md.isTrusted = { enabledCommands: [CMD.open, CMD.setFilter, CMD.showSessions, `${VIEW_ID}.focus`] };
      this.item.tooltip = md;
      this.rendered.tooltip = tooltip;
    }
    this.item.accessibilityInformation = { label: accessibleSummary(all), role: 'button' };
    if (!this.rendered.visible) {
      this.item.show();
      this.rendered.visible = true;
    }
  }

  renderView(all) {
    // The same count as the chip, like the Source Control badge.
    const working = countFor(all, 'busy');
    const waiting = countFor(all, 'waiting');
    const tooltip = [`${plural(working, 'agent')} working`, waiting ? `${waiting} waiting for you` : undefined].filter(Boolean).join(' · ');
    this.view.badge = working ? { value: working, tooltip } : undefined;
    this.view.description = this.filter === 'all' ? undefined : `${filterLabel(this.filter)} only`;
    this.panel.refresh();
  }

  tooltip(all, visible, cfg) {
    const where = SCOPE_TEXT[cfg.scope];
    if (!all.length) return `**Agents** · no sessions running ${where}`;

    const working = countFor(all, 'busy');
    let header = `**Agents** · ${plural(all.length, 'session')} ${where}${working ? `, ${working} working` : ''}`;
    if (this.filter !== 'all') header += ` · showing ${visible.length}`;

    const filters = FILTERS.map((f) => {
      const text = `${f.label} (${countFor(all, f.key)})`;
      return f.key === this.filter
        ? `**${text}**`
        : commandLink(text, CMD.setFilter, [f.key], `Show ${f.label.toLowerCase()} sessions`);
    }).join(' · ');

    const grouped = cfg.groupBy === 'branch';
    const showProvider = new Set(all.map((s) => s.providerId)).size > 1;
    const blocks = [];
    visible.slice(0, MAX_HOVER_ROWS).forEach((s, i, shown) => {
      if (grouped && (i === 0 || s.group.key !== shown[i - 1].group.key)) {
        const description = s.group.description ? ` · ${escapeMarkdown(s.group.description)}` : '';
        blocks.push(`$(git-branch) **${escapeMarkdown(s.group.label)}**${description}`);
      }
      blocks.push(this.hoverRow(s, cfg, { grouped, showProvider }));
    });
    let rows = blocks.length ? blocks.join('\n\n') : '_No sessions with this status._';
    if (visible.length > MAX_HOVER_ROWS) {
      rows += `\n\n_…and ${visible.length - MAX_HOVER_ROWS} more in the_ ${commandLink('session picker', CMD.showSessions)}`;
    }

    const footer = [
      commandLink('$(list-selection) Open session picker', CMD.showSessions),
      commandLink('$(layout-sidebar-left) Show panel', `${VIEW_ID}.focus`),
    ].join(' · ');
    return [header, `Filter: ${filters}`, '---', rows, '---', footer].join('\n\n');
  }

  hoverRow(s, cfg, { grouped, showProvider }) {
    const title = escapeMarkdown(truncate(s.title, MAX_TITLE));
    const meta = [s.statusLabel, formatElapsed(s.since), s.folder];
    if (!grouped && s.branchLabel) meta.push(s.branchLabel);
    if (s.empty) meta.push('no messages yet');
    if (showProvider) meta.push(s.providerLabel);
    if (whereElse(s)) meta.push(whereElse(s));
    const lines = [
      `${cfg.dots[s.status]} \`${s.n}\` ${commandLink(title, CMD.open, [s.key], 'Open this session')}`,
      escapeMarkdown(meta.join(' · ')),
    ];
    const doing = activity(s);
    if (s.status === 'waiting' && doing) lines.push(`_${escapeMarkdown(truncate(doing, MAX_DETAIL))}_`);
    else if (doing) lines.push(`$(${s.action ? s.action.icon : 'loading~spin'}) ${escapeMarkdown(truncate(doing, MAX_DETAIL))}`);
    return lines.join('  \n');
  }

  // --- Session picker -------------------------------------------------------

  showSessions() {
    if (this.picker) {
      this.picker.qp.show();
      return;
    }
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search by title, folder, branch or status';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    const rebuild = () => {
      const cfg = settings();
      const grouped = cfg.groupBy === 'branch';
      const filtered = this.filter !== 'all';
      qp.title = 'Agent Sessions' + (filtered ? ` · ${filterLabel(this.filter)}` : '');
      qp.buttons = [{ iconPath: new vscode.ThemeIcon(filtered ? 'filter-filled' : 'filter'), tooltip: 'Filter by status' }];

      const previous = qp.activeItems[0] && qp.activeItems[0].session && qp.activeItems[0].session.key;
      const items = [];
      this.visible().forEach((s, i, list) => {
        if (grouped && (i === 0 || s.group.key !== list[i - 1].group.key)) {
          items.push({ label: s.group.label, kind: vscode.QuickPickItemKind.Separator });
        }
        const doing = activity(s);
        items.push({
          label: `${cfg.dots[s.status]} ${s.n}  ${truncate(s.title, MAX_TITLE)}`,
          description: `${s.statusLabel} · ${formatElapsed(s.since)}`,
          detail: [doing && truncate(doing, MAX_DETAIL), s.folder, grouped ? undefined : s.branchLabel, whereElse(s)]
            .filter(Boolean)
            .join(' · '),
          session: s,
        });
      });
      qp.items = items;
      const sessionItems = items.filter((i) => i.session);
      // Keep the highlighted row across live updates; otherwise start on the first session that needs you.
      const active =
        sessionItems.find((i) => i.session.key === previous) ||
        sessionItems.find((i) => i.session.status === 'waiting') ||
        sessionItems[0];
      if (active) qp.activeItems = [active];
    };

    qp.onDidTriggerButton(() => {
      this.closePicker();
      this.pickFilter(true);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] || qp.activeItems[0];
      this.closePicker();
      if (item && item.session) this.open(item.session.key);
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
    qp.placeholder = 'Choose which sessions the chip and the panel show';
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

  // --- Opening sessions and files ---------------------------------------------

  // target: a session key, or a panel node holding a session.
  async open(target) {
    const key = typeof target === 'string' ? target : target && target.session && target.session.key;
    const s = this.sessions.find((x) => x.key === key);
    if (!s) {
      vscode.window.showWarningMessage('That agent session is no longer running.');
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
    if (s.surface !== 'editor') {
      vscode.window.showInformationMessage(`"${truncate(s.title, MAX_TITLE)}" is not attached to a chat or a terminal in this window.`);
      return;
    }
    if (!s.resumable) {
      vscode.window.showInformationMessage(
        s.empty
          ? `"${truncate(s.title, MAX_TITLE)}" has no messages yet, so there is nothing to open.`
          : `"${truncate(s.title, MAX_TITLE)}" cannot be opened yet; try again in a moment.`,
      );
      return;
    }
    const provider = this.providers.find((p) => p.id === s.providerId);
    if (!provider.canOpen(s)) {
      vscode.window.showWarningMessage(provider.unavailableReason());
      return;
    }
    try {
      await provider.open(s);
    } catch (err) {
      this.log.error(`Opening session ${s.key}: ${err.stack || err}`);
      vscode.window.showErrorMessage(`Could not open the session: ${err.message}`);
    }
  }

  // target: a session key with the file path, or a panel file node. entry is the session's record of
  // the file, with the repository it belongs to.
  resolveFile(target, file) {
    if (target && typeof target === 'object' && target.kind === 'file') {
      return { session: target.session, file: target.file.path, entry: target.file };
    }
    const session = this.sessions.find((s) => s.key === target);
    return { session, file, entry: session && session.files.find((f) => f.path === file) };
  }

  // The file's changes in the repository it lives in, from the commit the session's changes are
  // measured from to the working tree: everything the session did, committed or not.
  async openFileDiff(target, filePath) {
    const { session, file, entry } = this.resolveFile(target, filePath);
    if (!file) return;
    const fileUri = vscode.Uri.file(file);
    const root = entry && entry.root;
    if (!root) {
      await this.openFile(target, filePath);
      return;
    }
    const compare = entry.compare || { ref: 'HEAD', label: 'HEAD' };
    const baseUri = fileUri.with({ scheme: BASE_SCHEME, query: new URLSearchParams({ root, ref: compare.ref }).toString() });
    if (!fs.existsSync(file)) {
      await vscode.commands.executeCommand('vscode.open', baseUri); // Deleted: show what it was.
      return;
    }
    const from = compare.label === 'HEAD' ? 'HEAD' : `${compare.label} ${compare.ref.slice(0, 7)}`;
    const title = `${path.basename(file)} (${from} ↔ Working Tree)${session ? ` · ${truncate(session.title, 40)}` : ''}`;
    await vscode.commands.executeCommand('vscode.diff', baseUri, fileUri, title);
  }

  async openFile(target, filePath) {
    const { file } = this.resolveFile(target, filePath);
    if (!file) return;
    if (!fs.existsSync(file)) {
      vscode.window.showWarningMessage(`${file} no longer exists.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
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
  const soundFile = (key) => {
    const value = typeof c.get(key) === 'string' ? c.get(key).trim() : '';
    return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  };
  return {
    scope: oneOf('scope', ['window', 'workspace', 'all']),
    order: oneOf('order', ['stable', 'status']),
    groupBy: oneOf('groupBy', ['none', 'branch']),
    showEmptySessions: c.get('showEmptySessions') === true,
    icon: typeof icon === 'string' && /^[a-z0-9-]+$/.test(icon) ? icon : 'agent-status-robot',
    iconReflectsStatus: c.get('iconReflectsStatus') !== false,
    maxDots: Number.isInteger(maxDots) ? Math.min(50, Math.max(1, maxDots)) : 8,
    hideWhenEmpty: c.get('hideWhenEmpty') === true,
    soundOnFinish: c.get('soundOnFinish') !== false,
    soundOnWaiting: c.get('soundOnWaiting') !== false,
    notifyOnWaiting: c.get('notifyOnWaiting') !== false,
    finishSoundFile: soundFile('finishSoundFile'),
    waitingSoundFile: soundFile('waitingSoundFile'),
    dots,
  };
}

function setGroupBy(value) {
  return vscode.workspace.getConfiguration('agentStatus').update('groupBy', value, vscode.ConfigurationTarget.Global);
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

// --- Ordering and formatting --------------------------------------------------------

// Sorts the sessions, keeps each branch or worktree together when grouping, and numbers them in the
// order they are shown everywhere.
function arrange(sessions, cfg) {
  sessions.sort(cfg.order === 'status' ? byStatus : byStart);
  for (const s of sessions) s.group = groupOf(s);
  let arranged = sessions;
  if (cfg.groupBy === 'branch') {
    const groups = new Map();
    for (const s of sessions) {
      if (!groups.has(s.group.key)) groups.set(s.group.key, []);
      groups.get(s.group.key).push(s);
    }
    arranged = [...groups.values()].flat();
  }
  arranged.forEach((s, i) => {
    s.n = i + 1;
  });
  return arranged;
}

// Sessions in the same working tree share a group; each worktree is a group of its own.
function groupOf(s) {
  if (s.repo) {
    return {
      key: `repo:${s.repo.root}`,
      label: s.repo.label,
      description: s.repo.worktree ? `${s.repo.name} · worktree` : s.repo.name,
      root: s.repo.root,
    };
  }
  return { key: 'none', label: 'Not in a git repository', description: '', root: undefined };
}

function byStart(a, b) {
  return a.startedAt - b.startedAt || a.pid - b.pid;
}

function byStatus(a, b) {
  return STATUS[a.status].rank - STATUS[b.status].rank || byStart(a, b);
}

// What the session is doing right now, in words: its current tool call while it works, or what it
// waits for.
function activity(s) {
  if (s.status === 'waiting') return s.waitingFor || 'Waiting for your decision';
  if (s.status === 'busy') return s.action ? s.action.text : 'Thinking…';
  return undefined;
}

function whereElse(s) {
  if (s.owned) return undefined;
  return s.surface === 'editor' ? 'another VS Code window' : 'a terminal outside VS Code';
}

function urgentColor(sessions) {
  if (sessions.some((s) => s.status === 'waiting')) return STATUS.waiting.color;
  if (sessions.some((s) => s.status === 'busy')) return STATUS.busy.color;
  return undefined;
}

function accessibleSummary(sessions) {
  if (!sessions.length) return 'Agent Status: no sessions';
  const parts = FILTERS.filter((f) => f.key !== 'all')
    .map((f) => `${countFor(sessions, f.key)} ${f.label.toLowerCase()}`)
    .join(', ');
  return `Agent sessions: ${parts}`;
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
