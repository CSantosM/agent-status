#!/usr/bin/env node
// Renders the README images in docs/images from HTML mockups of the extension's UI, drawn with
// VS Code's own icon font and its Dark Modern colors. The sessions shown are made up.
// Usage: node docs/render.js
// Needs Google Chrome or Chromium, and a VS Code install for its codicon font (or set CHROME and
// CODICON_TTF).
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'images');
const SCALE = 2;

const CODICON_TTF =
  process.env.CODICON_TTF ||
  [
    '/usr/share/code/resources/app/out/media/codicon.ttf',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/out/media/codicon.ttf',
  ].find((file) => fs.existsSync(file));
const CHROME =
  process.env.CHROME ||
  ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((bin) => {
    try {
      childProcess.execFileSync('which', [bin], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });

// Code points from VS Code's codicon font.
const ICONS = {
  robot: 60448,
  filter: 60145,
  'list-selection': 60293,
  bell: 60066,
  check: 60082,
  blank: 60419,
  remote: 60218,
  'git-branch': 60527,
  error: 60039,
  warning: 60012,
};

const COLORS = { waiting: '#F44336', busy: '#FBC02D', idle: '#CCCCCC', empty: 'rgba(204, 204, 204, 0.5)' };
const DOT = { busy: '🟡', waiting: '🔴', idle: '🟢' };

const SESSIONS = [
  { title: 'fix/login-redirect', status: 'busy', label: 'Working', since: '3 min', folder: 'web-app' },
  {
    title: 'Refactor the recording service',
    status: 'waiting',
    label: 'Waiting',
    since: '1 min',
    folder: 'web-app/api',
    waitingFor: 'Permission to run Bash(npm test)',
  },
  { title: 'End-to-end tests for rooms', status: 'idle', label: 'Idle', since: '12 min', folder: 'web-app' },
  { title: 'docs/update-readme', status: 'busy', label: 'Working', since: '<1 min', folder: 'web-app' },
  { title: 'Migrate to Node 22', status: 'idle', label: 'Idle', since: '1 h', folder: 'web-app/api' },
];

const CODE = [
  [['import', 'kw2'], [' { ', ''], ['EventEmitter', 'var'], [' } ', ''], ['from', 'kw2'], [" 'node:events'", 'str'], [';', '']],
  [['import', 'kw2'], [' ', ''], ['type', 'kw2'], [' { ', ''], ['Room', 'var'], [' } ', ''], ['from', 'kw2'], [" './room'", 'str'], [';', '']],
  [],
  [['export', 'kw2'], [' ', ''], ['class', 'kw'], [' ', ''], ['RoomService', 'type'], [' ', ''], ['extends', 'kw'], [' ', ''], ['EventEmitter', 'type'], [' {', '']],
  [['  ', ''], ['private', 'kw'], [' ', ''], ['readonly', 'kw'], [' ', ''], ['rooms', 'var'], [' = ', ''], ['new', 'kw'], [' ', ''], ['Map', 'type'], ['<', ''], ['string', 'type'], [', ', ''], ['Room', 'type'], ['>();', '']],
  [],
  [['  ', ''], ['async', 'kw'], [' ', ''], ['startRecording', 'fn'], ['(', ''], ['roomId', 'var'], [': ', ''], ['string', 'type'], ['): ', ''], ['Promise', 'type'], ['<', ''], ['void', 'type'], ['> {', '']],
  [['    ', ''], ['const', 'kw'], [' ', ''], ['room', 'const'], [' = ', ''], ['this', 'kw'], ['.', ''], ['rooms', 'var'], ['.', ''], ['get', 'fn'], ['(', ''], ['roomId', 'var'], [');', '']],
  [['    ', ''], ['if', 'kw2'], [' (!', ''], ['room', 'const'], [') {', '']],
  [['      ', ''], ['throw', 'kw2'], [' ', ''], ['new', 'kw'], [' ', ''], ['Error', 'type'], ['(', ''], ['`Unknown room: ', 'str'], ['${', 'kw'], ['roomId', 'var'], ['}', 'kw'], ['`', 'str'], [');', '']],
  [['    }', '']],
  [['    ', ''], ['await', 'kw2'], [' ', ''], ['room', 'const'], ['.', ''], ['recorder', 'var'], ['.', ''], ['start', 'fn'], ['();', '']],
  [['    ', ''], ['this', 'kw'], ['.', ''], ['emit', 'fn'], ['(', ''], ["'recording-started'", 'str'], [', ', ''], ['roomId', 'var'], [');', '']],
  [['  }', '']],
  [['}', '']],
];

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const icon = (name) => `<span class="codicon">&#${ICONS[name]};</span>`;

function css() {
  const font = fs.readFileSync(CODICON_TTF).toString('base64');
  return `
@font-face { font-family: codicon; src: url(data:font/ttf;base64,${font}) format("truetype"); }
* { box-sizing: border-box; }
html, body { margin: 0; background: #1f1f1f; color: #cccccc; font-family: "Noto Sans", "Ubuntu", sans-serif; -webkit-font-smoothing: antialiased; }
.codicon { font-family: codicon; font-size: 16px; line-height: 1; display: inline-block; vertical-align: -3px; }
.frame { position: relative; overflow: hidden; background: #1f1f1f; }
.tabs { height: 35px; background: #181818; border-bottom: 1px solid #2b2b2b; display: flex; }
.tab { padding: 0 14px; display: flex; align-items: center; gap: 6px; background: #1f1f1f; border-top: 1px solid #0078d4; border-right: 1px solid #2b2b2b; color: #ffffff; font-size: 13px; }
.tab .lang { color: #4d9fe0; font-size: 10px; font-weight: 700; }
.code { padding-top: 6px; font-family: "Noto Sans Mono", monospace; font-size: 13px; line-height: 19px; }
.code .line { display: flex; white-space: pre; }
.code .ln { width: 44px; padding-right: 22px; text-align: right; color: #6e7681; }
.kw { color: #569cd6; } .kw2 { color: #c586c0; } .str { color: #ce9178; } .type { color: #4ec9b0; }
.fn { color: #dcdcaa; } .var { color: #9cdcfe; } .const { color: #4fc1ff; }
.statusbar { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; background: #181818; border-top: 1px solid #2b2b2b; display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.statusbar .side { display: flex; height: 100%; align-items: center; }
.item { height: 100%; padding: 0 5px; margin: 0 1px; display: flex; align-items: center; white-space: pre; }
.item.remote { background: #0078d4; color: #ffffff; padding: 0 9px; margin: 0; }
.item.hovered { background: rgba(255, 255, 255, 0.12); }
.hover { position: absolute; background: #202020; border: 1px solid #454545; border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); padding: 4px 8px; font-size: 13px; line-height: 1.45; max-width: 500px; }
.hover p { margin: 8px 0; }
.hover hr { border: 0; border-top: 1px solid #454545; margin: 4px -8px; }
.hover a { color: #4daafc; text-decoration: none; }
.hover code { font-family: "Noto Sans Mono", monospace; font-size: 12px; background: #2b2b2b; border-radius: 3px; padding: 0 4px; }
.hover em { color: #cccccc; }
.qi { position: absolute; width: 600px; background: #222222; border-radius: 6px; box-shadow: 0 0 8px 2px rgba(0, 0, 0, 0.45); padding-bottom: 6px; font-size: 13px; }
.qi .title { height: 30px; display: flex; align-items: center; padding: 0 8px; }
.qi .title .text { flex: 1; text-align: center; }
.qi .title .actions { width: 40px; display: flex; justify-content: flex-end; }
.qi .input { margin: 0 6px 6px; height: 26px; padding: 0 8px; display: flex; align-items: center; background: #313131; border: 1px solid #0078d4; border-radius: 2px; color: #989898; }
.qi .row { padding: 3px 11px; }
.qi .row.active { background: #04395e; color: #ffffff; }
.qi .desc, .qi .detail { color: #9d9d9d; font-size: 12px; }
.qi .row.active .desc, .qi .row.active .detail { color: #c8c8c8; }
.qi .desc { margin-left: 8px; }
.states { padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; }
.state { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.state .caption { font-size: 13px; }
.state .caption small { display: block; color: #9d9d9d; font-size: 12px; margin-top: 2px; }
.state .bar { position: relative; width: 300px; height: 22px; background: #181818; border-top: 1px solid #2b2b2b; display: flex; justify-content: flex-end; align-items: center; font-size: 12px; }
`;
}

function chip({ color, dots = '', more = '', filter = false, hovered = false }) {
  let label = icon('robot');
  if (dots) label += ` ${dots}`;
  if (more) label += ` ${more}`;
  if (filter) label += ` ${icon('filter')}`;
  return `<div class="item${hovered ? ' hovered' : ''}" style="color: ${color}">${label}</div>`;
}

const bell = () => `<div class="item">${icon('bell')}</div>`;
const sessionDots = () => SESSIONS.map((s) => DOT[s.status]).join('');

function statusBar(chipHtml) {
  return `<div class="statusbar">
  <div class="side"><div class="item remote">${icon('remote')}</div><div class="item">${icon('git-branch')} main</div><div class="item">${icon('error')} 0  ${icon('warning')} 0</div></div>
  <div class="side"><div class="item">Ln 9, Col 18</div><div class="item">Spaces: 2</div><div class="item">UTF-8</div><div class="item">LF</div><div class="item">TypeScript</div>${chipHtml}${bell()}</div>
</div>`;
}

function editor(file = 'room.service.ts') {
  const lines = CODE.map(
    (tokens, i) =>
      `<div class="line"><span class="ln">${i + 1}</span><span>${tokens
        .map(([text, cls]) => (cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text)))
        .join('')}</span></div>`,
  ).join('');
  return `<div class="tabs"><div class="tab"><span class="lang">TS</span>${file}</div></div><div class="code">${lines}</div>`;
}

function hoverCard() {
  const link = (text) => `<a>${text}</a>`;
  const counts = { busy: 0, waiting: 0, idle: 0 };
  SESSIONS.forEach((s) => (counts[s.status] += 1));
  const rows = SESSIONS.map((s, i) => {
    let row = `${DOT[s.status]} <code>${i + 1}</code> ${link(esc(s.title))}<br>${s.label} · ${esc(s.since)} · ${s.folder}`;
    if (s.waitingFor) row += `<br><em>${esc(s.waitingFor)}</em>`;
    return `<p>${row}</p>`;
  }).join('');
  return `<div class="hover" style="right: 20px; bottom: 26px;">
  <p><strong>Claude Code</strong> · ${SESSIONS.length} sessions in this window</p>
  <p>Filter: <strong>All (${SESSIONS.length})</strong> · ${link(`Working (${counts.busy})`)} · ${link(`Waiting (${counts.waiting})`)} · ${link(`Idle (${counts.idle})`)}</p>
  <hr>${rows}<hr>
  <p>${link(`${icon('list-selection')} Open session picker`)} · or click the chip</p>
</div>`;
}

function picker() {
  const activeIndex = SESSIONS.findIndex((s) => s.status === 'waiting');
  const rows = SESSIONS.map((s, i) => {
    const detail = [s.waitingFor, s.folder].filter(Boolean).join(' · ');
    return `<div class="row${i === activeIndex ? ' active' : ''}">
  <div>${DOT[s.status]} ${i + 1}&nbsp;&nbsp;${esc(s.title)}<span class="desc">${s.label} · ${esc(s.since)}</span></div>
  <div class="detail">${esc(detail)}</div>
</div>`;
  }).join('');
  return `<div class="qi" style="left: 80px; top: 44px;">
  <div class="title"><div class="actions"></div><div class="text">Claude Code Sessions</div><div class="actions">${icon('filter')}</div></div>
  <div class="input">Search by title, folder or status</div>
  ${rows}
</div>`;
}

const STATES = [
  { caption: 'No sessions', note: 'Only the icon, dimmed', chip: { color: COLORS.empty } },
  { caption: 'All idle', note: 'Every session finished', chip: { color: COLORS.idle, dots: '🟢🟢🟢' } },
  { caption: 'Some working', note: 'The icon turns yellow', chip: { color: COLORS.busy, dots: '🟢🟡🟢🟡' } },
  { caption: 'Someone needs you', note: 'The icon turns red', chip: { color: COLORS.waiting, dots: sessionDots() } },
  { caption: 'Filtered to Waiting', note: 'A funnel shows while a filter is on', chip: { color: COLORS.waiting, dots: '🔴', filter: true } },
  { caption: 'More than 8 sessions', note: 'The rest are grouped as +N', chip: { color: COLORS.busy, dots: '🟢🟡🟢🟡🟢🟢🟡🟢', more: '+3' } },
];

const IMAGES = [
  {
    name: 'hover.png',
    width: 820,
    height: 520,
    body: `<div class="frame" style="width: 820px; height: 520px;">${editor()}${hoverCard()}${statusBar(
      chip({ color: COLORS.waiting, dots: sessionDots(), hovered: true }),
    )}</div>`,
  },
  {
    name: 'picker.png',
    width: 760,
    height: 380,
    body: `<div class="frame" style="width: 760px; height: 380px;">${editor()}${picker()}</div>`,
  },
  {
    name: 'states.png',
    width: 560,
    height: 20 * 2 + STATES.length * 38 + (STATES.length - 1) * 10,
    body: `<div class="states">${STATES.map(
      (s) => `<div class="state"><div class="caption">${s.caption}<small>${s.note}</small></div><div class="bar">${chip(s.chip)}${bell()}</div></div>`,
    ).join('')}</div>`,
  },
];

function render() {
  if (!CHROME) throw new Error('Google Chrome or Chromium not found; set CHROME.');
  if (!CODICON_TTF) throw new Error("VS Code's codicon.ttf not found; set CODICON_TTF.");
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-docs-'));
  try {
    const style = css();
    for (const image of IMAGES) {
      const html = path.join(work, image.name.replace('.png', '.html'));
      fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${image.body}</body></html>`);
      childProcess.execFileSync(
        CHROME,
        [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          `--user-data-dir=${path.join(work, 'profile')}`,
          `--force-device-scale-factor=${SCALE}`,
          `--window-size=${image.width},${image.height}`,
          '--virtual-time-budget=3000',
          `--screenshot=${path.join(OUT, image.name)}`,
          `file://${html}`,
        ],
        { stdio: 'ignore' },
      );
      console.log(`Rendered docs/images/${image.name}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

render();
