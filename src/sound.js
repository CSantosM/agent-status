'use strict';

const childProcess = require('child_process');
const fs = require('fs');

// Tried in order until one plays the file.
const PLAYERS = {
  linux: [
    ['pw-play', (file) => [file]],
    ['paplay', (file) => [file]],
    ['aplay', (file) => ['-q', file]],
  ],
  darwin: [['afplay', (file) => [file]]],
  win32: [
    [
      'powershell.exe',
      (file) => ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`],
    ],
  ],
};
const GAP_MS = 1000;
const TIMEOUT_MS = 5000;

class Sound {
  constructor({
    builtIn,
    warn = () => {},
    log,
    platform = process.platform,
    spawn = childProcess.spawn,
    exists = fs.existsSync,
    timeoutMs = TIMEOUT_MS,
    gapMs = GAP_MS,
  }) {
    Object.assign(this, { builtIn, warn, log, spawn, exists, timeoutMs, gapMs });
    this.players = PLAYERS[platform] || [];
    this.player = undefined; // The last one that worked goes first next time.
    this.lastPlayed = 0;
    this.warned = new Set();
  }

  // force: asked for by the user, so it plays right away and every problem is reported.
  play(file, { force = false } = {}) {
    const now = Date.now();
    // Several sessions finishing within a second make a single blip.
    if (!force && now - this.lastPlayed < this.gapMs) return false;
    this.lastPlayed = now;

    let target = this.builtIn;
    if (file) {
      if (this.exists(file)) target = file;
      else this.warnOnce(`missing:${file}`, `Sound file not found: ${file}. Playing the built-in blip instead.`, force);
    }
    const ordered = this.player ? [this.player, ...this.players.filter((p) => p !== this.player)] : this.players;
    this.run(target, ordered, force);
    return true;
  }

  run(file, players, force) {
    const [player, ...rest] = players;
    if (!player) {
      const tried = this.players.map(([command]) => command).join(', ') || 'none for this platform';
      this.warnOnce('no-player', `Could not play ${file}: no audio player worked (tried ${tried}).`, force);
      return;
    }
    const [command, args] = player;
    let settled = false;
    let timer;
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.log) this.log.debug(`${command} could not play ${file}: ${reason}`);
      this.run(file, rest, force);
    };

    let child;
    try {
      child = this.spawn(command, args(file), { stdio: 'ignore' });
    } catch (err) {
      fail(err.message);
      return;
    }
    // A player stuck on a sound server that does not answer would pile up with every blip.
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      fail('timed out');
    }, this.timeoutMs);
    child.on('error', (err) => fail(err.code || err.message));
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        this.player = player;
      } else {
        fail(`exited with ${code === null ? signal : code}`);
      }
    });
  }

  warnOnce(key, message, force) {
    if (this.log) this.log.warn(message);
    if (force || !this.warned.has(key)) {
      this.warned.add(key);
      this.warn(message);
    }
  }
}

module.exports = { Sound, PLAYERS };
