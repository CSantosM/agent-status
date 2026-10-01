'use strict';

// Test doubles: a minimal `vscode` module, a fake Claude config directory and real processes that
// stand in for Claude sessions (the extension checks PIDs and the process tree in /proc).

const Module = require('module');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');

function createVscode() {
  const state = {
    handlers: {},
    items: [],
    views: [],
    contentProviders: {},
    messages: [],
    executed: [],
    updates: [],
    spawned: [],
    failUpdates: false,
    onExecute: undefined,
    extensions: { 'anthropic.claude-code': {} },
    workspaceFolders: [],
    terminals: [],
    config: { agentStatus: {}, claudeCode: { global: { preferredLocation: 'panel' }, workspace: {} } },
  };
  const disposable = () => ({ dispose() {} });
  const respond = (level, message, buttons) => {
    state.messages.push([level, message, buttons]);
    return state.respond ? state.respond(message, buttons) : undefined;
  };
  const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

  const getConfiguration = (section) => ({
    get(key, fallback) {
      if (section === 'claudeCode') {
        const { workspace, global } = state.config.claudeCode;
        return workspace[key] ?? global[key] ?? fallback;
      }
      const value = (state.config[section] || {})[key];
      return value === undefined ? fallback : value;
    },
    inspect(key) {
      if (section !== 'claudeCode') return {};
      return { globalValue: state.config.claudeCode.global[key], workspaceValue: state.config.claudeCode.workspace[key] };
    },
    async update(key, value, target) {
      if (state.failUpdates) throw new Error('Unable to write into user settings');
      state.updates.push({ section, key, value, target });
      if (section !== 'claudeCode') {
        state.config[section] = state.config[section] || {};
        if (value === undefined) delete state.config[section][key];
        else state.config[section][key] = value;
        return;
      }
      const bucket = target === ConfigurationTarget.Workspace ? state.config.claudeCode.workspace : state.config.claudeCode.global;
      if (value === undefined) delete bucket[key];
      else bucket[key] = value;
    },
  });

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    MarkdownString: class {
      constructor(value = '') {
        this.value = value;
      }
      appendMarkdown(text) {
        this.value += text;
        return this;
      }
      appendText(text) {
        this.value += text;
        return this;
      }
    },
    QuickInputButtons: { Back: { id: 'back' } },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class {
      constructor(labelOrUri, collapsibleState) {
        if (typeof labelOrUri === 'string') this.label = labelOrUri;
        else this.resourceUri = labelOrUri;
        this.collapsibleState = collapsibleState;
      }
    },
    EventEmitter: class {
      constructor() {
        this.listeners = [];
        this.event = (listener) => {
          this.listeners.push(listener);
          return { dispose() {} };
        };
      }
      fire(value) {
        this.listeners.forEach((listener) => listener(value));
      }
      dispose() {}
    },
    Uri: {
      file: (fsPath) => {
        const uri = {
          scheme: 'file',
          fsPath,
          path: fsPath,
          query: '',
          with: (change) => ({ ...uri, ...change }),
        };
        return uri;
      },
    },
    window: {
      createTreeView: (id, options) => {
        const view = { id, provider: options.treeDataProvider, badge: undefined, description: undefined, dispose() {} };
        state.views.push(view);
        return view;
      },
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => {
        const item = {
          visible: false,
          show() {
            item.visible = true;
          },
          hide() {
            item.visible = false;
          },
          dispose() {},
        };
        state.items.push(item);
        return item;
      },
      get terminals() {
        return state.terminals;
      },
      onDidOpenTerminal: disposable,
      onDidCloseTerminal: disposable,
      // state.respond(message, buttons) picks the button a test "clicks".
      showInformationMessage: async (message, ...buttons) => respond('info', message, buttons),
      showWarningMessage: async (message, ...buttons) => respond('warn', message, buttons),
      showErrorMessage: async (message, ...buttons) => respond('error', message, buttons),
    },
    commands: {
      registerCommand(id, handler) {
        state.handlers[id] = handler;
        return disposable();
      },
      async executeCommand(id, ...args) {
        state.executed.push({ id, args, preferredLocation: getConfiguration('claudeCode').get('preferredLocation') });
        if (state.onExecute) return state.onExecute(id, args);
        return undefined;
      },
    },
    extensions: { getExtension: (id) => state.extensions[id] },
    workspace: {
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      getConfiguration,
      registerTextDocumentContentProvider: (scheme, provider) => {
        state.contentProviders[scheme] = provider;
        return disposable();
      },
      onDidChangeWorkspaceFolders: disposable,
      onDidChangeConfiguration: disposable,
    },
  };

  // Audio players never run for real: sound.js gets a child_process whose players exit at once.
  const fakeChildProcess = {
    spawn(command, args) {
      state.spawned.push({ command, args });
      const child = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.emit('exit', 0, null), 5);
      return child;
    },
  };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'vscode') return vscode;
    if (request === 'child_process' && parent && parent.filename === path.join(ROOT, 'src', 'sound.js')) {
      return fakeChildProcess;
    }
    return load.call(this, request, parent, ...rest);
  };

  return { vscode, state };
}

function createContext() {
  const store = new Map();
  return {
    subscriptions: [],
    extensionPath: ROOT,
    globalState: {
      get: (key) => store.get(key),
      update: async (key, value) => {
        if (value === undefined) store.delete(key);
        else store.set(key, value);
      },
    },
  };
}

function disposeContext(context) {
  for (const d of context.subscriptions) d.dispose();
}

function createClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-test-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.mkdirSync(path.join(dir, 'projects'));
  return dir;
}

// A live child of this test process, with the start time Claude Code would record for it.
function spawnSessionProcess() {
  const child = childProcess.spawn('sleep', ['120'], { stdio: 'ignore' });
  return { pid: child.pid, procStart: procStartOf(child.pid), kill: () => child.kill() };
}

// A live process that does not descend from this test process (its parent exits at once), like a
// session started by another VS Code window.
function spawnForeignProcess() {
  const pid = Number(childProcess.execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'").toString().trim());
  return {
    pid,
    procStart: procStartOf(pid),
    kill: () => {
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    },
  };
}

function procStartOf(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
}

let counter = 0;
function writeSession(claudeDir, proc, fields = {}) {
  const record = {
    pid: proc.pid,
    sessionId: fields.sessionId || `session-${++counter}`,
    cwd: '/tmp/project',
    startedAt: Date.now() - 60000,
    procStart: proc.procStart,
    kind: 'interactive',
    entrypoint: 'claude-vscode',
    name: 'project-1a',
    nameSource: 'derived',
    status: 'idle',
    statusUpdatedAt: Date.now(),
    ...fields,
  };
  fs.writeFileSync(path.join(claudeDir, 'sessions', `${proc.pid}.json`), JSON.stringify(record));
  return record;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ROOT,
  createVscode,
  createContext,
  disposeContext,
  createClaudeDir,
  spawnSessionProcess,
  spawnForeignProcess,
  writeSession,
  delay,
};
