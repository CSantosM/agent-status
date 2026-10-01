'use strict';

// The Agent Status view: one row per session, optionally grouped by branch or worktree. Each session
// expands into what it is doing and the files it edited; a file opens its changes against HEAD.

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { formatElapsed, truncate } = require('./util');

const STATUS_ICON = {
  busy: ['circle-filled', 'charts.yellow'],
  waiting: ['circle-filled', 'charts.red'],
  idle: ['circle-filled', 'charts.green'],
  unknown: ['circle-outline', 'disabledForeground'],
};
const MAX_TITLE = 80;

class SessionsPanel {
  // host: { visible(), settings(), git, whereElse(session), activity(session) }
  constructor(host) {
    this.host = host;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.signature = undefined;
  }

  // Redraws only when something shown changed, so expanded rows and scrolling stay put.
  refresh() {
    const signature = JSON.stringify([
      this.host.settings().groupBy,
      this.host.visible().map((s) => [
        s.key,
        s.status,
        s.title,
        this.host.activity(s),
        s.files.map((f) => f.path).join('|'),
        s.group.key,
        s.group.label,
        Math.floor(s.since / 60000),
        s.owned,
        s.openable,
      ]),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.emitter.fire(undefined);
  }

  dispose() {
    this.emitter.dispose();
  }

  getTreeItem(node) {
    return node.item;
  }

  async getChildren(node) {
    if (!node) return this.roots();
    if (node.kind === 'group') return node.sessions.map((s) => this.sessionNode(s, true));
    if (node.kind === 'session') return this.sessionChildren(node.session);
    if (node.kind === 'files') return this.fileNodes(node.session);
    return [];
  }

  roots() {
    const sessions = this.host.visible();
    if (this.host.settings().groupBy !== 'branch') return sessions.map((s) => this.sessionNode(s, false));
    const groups = new Map();
    for (const s of sessions) {
      if (!groups.has(s.group.key)) groups.set(s.group.key, { ...s.group, sessions: [] });
      groups.get(s.group.key).sessions.push(s);
    }
    return [...groups.values()].map((group) => {
      const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${group.key}`;
      item.description = group.description;
      item.tooltip = group.root || group.label;
      item.iconPath = new vscode.ThemeIcon(group.root ? 'git-branch' : 'folder');
      item.contextValue = 'group';
      return { kind: 'group', sessions: group.sessions, item };
    });
  }

  sessionNode(s, grouped) {
    const item = new vscode.TreeItem(truncate(s.title, MAX_TITLE), vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `session:${s.key}`;
    item.description = [s.statusLabel, formatElapsed(s.since), grouped ? undefined : s.branchLabel].filter(Boolean).join(' · ');
    const [icon, color] = STATUS_ICON[s.status] || STATUS_ICON.unknown;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.contextValue = s.openable ? 'session.openable' : 'session';
    item.command = { command: 'agentStatus.open', title: 'Open Session', arguments: [s.key] };
    item.tooltip = this.sessionTooltip(s);
    item.accessibilityInformation = { label: `${s.title}, ${s.statusLabel}, ${this.host.activity(s) || s.folder}` };
    return { kind: 'session', session: s, item };
  }

  sessionTooltip(s) {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**');
    md.appendText(s.title);
    md.appendMarkdown('**\n\n');
    const lines = [
      `${s.statusLabel} for ${formatElapsed(s.since)}`,
      this.host.activity(s),
      `${s.folder}${s.branchLabel ? ` · ${s.branchLabel}` : ''}`,
      s.providerLabel,
      this.host.whereElse(s) && `Running in ${this.host.whereElse(s)}`,
    ].filter(Boolean);
    lines.forEach((line, i) => {
      md.appendText(line);
      if (i < lines.length - 1) md.appendMarkdown('  \n');
    });
    return md;
  }

  sessionChildren(s) {
    const children = [];
    const info = (key, text, icon, tooltip) => {
      const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
      item.id = `${s.key}:${key}`;
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = tooltip || text;
      item.contextValue = 'info';
      children.push({ kind: 'info', session: s, item });
    };

    const activity = this.host.activity(s);
    if (s.status === 'waiting') info('activity', activity, 'bell-dot');
    else if (activity) info('activity', activity, s.action ? s.action.icon : 'loading~spin');
    info('folder', s.folder, 'folder', s.cwd);
    const elsewhere = this.host.whereElse(s);
    if (elsewhere) info('elsewhere', `Running in ${elsewhere}`, 'info');

    if (s.files.length) {
      const item = new vscode.TreeItem('Files edited', vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${s.key}:files`;
      item.description = String(s.files.length);
      item.iconPath = new vscode.ThemeIcon('files');
      item.contextValue = 'files';
      children.push({ kind: 'files', session: s, item });
    } else {
      info('files', 'No files edited yet', 'files');
    }
    return children;
  }

  async fileNodes(s) {
    const changes = s.repo ? await this.host.git.fileChanges(s.repo.root, s.files.map((f) => f.path)) : new Map();
    const base = s.repo ? s.repo.root : s.cwd;
    return s.files.map((f) => {
      const change = changes.get(f.path);
      const item = new vscode.TreeItem(vscode.Uri.file(f.path), vscode.TreeItemCollapsibleState.None);
      item.id = `${s.key}:file:${f.path}`;
      item.description = [folderOf(f.path, base), describeChange(change)].filter(Boolean).join(' · ');
      item.tooltip = f.path;
      item.contextValue = 'file';
      item.command = { command: 'agentStatus.openFileDiff', title: 'Open Changes', arguments: [s.key, f.path] };
      return { kind: 'file', session: s, file: f, item };
    });
  }
}

function folderOf(file, base) {
  const relative = path.relative(base, path.dirname(file));
  if (!relative) return '';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const dir = path.dirname(file);
  const home = os.homedir();
  return dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

function describeChange(change) {
  if (!change) return undefined;
  switch (change.status) {
    case 'modified':
    case 'renamed':
      return change.added === undefined ? 'modified' : `+${change.added} −${change.removed}`;
    case 'added':
    case 'untracked':
      return change.added === undefined ? 'new' : `new · +${change.added}`;
    case 'deleted':
      return 'deleted';
    case 'unchanged':
      return 'no changes';
    default:
      return undefined;
  }
}

module.exports = { SessionsPanel, describeChange };
