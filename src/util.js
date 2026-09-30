'use strict';

function formatElapsed(ms) {
  // Minute granularity keeps the hover text stable between refreshes.
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Counts code points, so an emoji is never cut in half.
function truncate(text, max) {
  const chars = Array.from(String(text));
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

// Escapes markdown syntax and $(icon) references in text that comes from session data.
function escapeMarkdown(text) {
  return String(text)
    .replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, '\\$&')
    .replace(/\s*\n\s*/g, ' ');
}

function commandLink(text, command, args, title) {
  const query = args ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[${text}](command:${command}${query}${title ? ` "${title}"` : ''})`;
}

// Session timestamps are epoch milliseconds; tolerate seconds in case the format changes.
function toMillis(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves to { value } or { timedOut: true }. A rejection before the deadline still rejects.
function withTimeout(promise, ms) {
  const settled = Promise.resolve(promise);
  settled.catch(() => {}); // A rejection after the deadline has nobody left to report to.
  let timer;
  return Promise.race([
    settled.then((value) => ({ value })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { formatElapsed, plural, truncate, escapeMarkdown, commandLink, toMillis, delay, withTimeout };
