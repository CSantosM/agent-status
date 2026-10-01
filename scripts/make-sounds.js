// Generates the built-in sounds in media/:
//   finish.wav   one 90 ms blip gliding up from 880 Hz to 1320 Hz (a session finished its turn)
//   waiting.wav  two quicker, higher blips (a session waits for your decision)
// Run with `node scripts/make-sounds.js` after changing any of the numbers below.
'use strict';

const fs = require('fs');
const path = require('path');

const RATE = 44100;
const GAIN = 0.5;

const SOUNDS = {
  'finish.wav': [{ start: 0, duration: 0.09, fromHz: 880, toHz: 1320 }],
  'waiting.wav': [
    { start: 0, duration: 0.07, fromHz: 1175, toHz: 1568 },
    { start: 0.13, duration: 0.07, fromHz: 1175, toHz: 1568 },
  ],
};

function synthesize(blips) {
  const total = Math.max(...blips.map((b) => b.start + b.duration));
  const samples = new Float64Array(Math.round(RATE * total));
  for (const { start, duration, fromHz, toHz } of blips) {
    const offset = Math.round(start * RATE);
    const length = Math.round(duration * RATE);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / RATE;
      phase += (2 * Math.PI * (fromHz + (toHz - fromHz) * (t / duration))) / RATE;
      // Short attack and release avoid clicks; the exponential decay makes it a blip rather than a beep.
      const envelope = Math.min(1, t / 0.004) * Math.min(1, (duration - t) / 0.01) * Math.exp(-t / 0.04);
      samples[offset + i] += Math.sin(phase) * envelope * GAIN;
    }
  }
  return samples;
}

function wav(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const dir = path.join(__dirname, '..', 'media');
fs.mkdirSync(dir, { recursive: true });
for (const [name, blips] of Object.entries(SOUNDS)) {
  fs.writeFileSync(path.join(dir, name), wav(synthesize(blips)));
  console.log(`Wrote media/${name}`);
}
