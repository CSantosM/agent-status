// Generates media/blip.wav: a 90 ms sine blip that glides up from 880 Hz to 1320 Hz.
// Run with `node scripts/make-blip.js` after changing any of the numbers below.
'use strict';

const fs = require('fs');
const path = require('path');

const RATE = 44100;
const DURATION = 0.09;
const FROM_HZ = 880;
const TO_HZ = 1320;
const GAIN = 0.5;

const samples = Math.round(RATE * DURATION);
const pcm = Buffer.alloc(samples * 2);
let phase = 0;
for (let i = 0; i < samples; i++) {
  const t = i / RATE;
  phase += (2 * Math.PI * (FROM_HZ + (TO_HZ - FROM_HZ) * (t / DURATION))) / RATE;
  // Short attack and release avoid clicks; the exponential decay makes it a blip rather than a beep.
  const envelope = Math.min(1, t / 0.004) * Math.min(1, (DURATION - t) / 0.01) * Math.exp(-t / 0.04);
  pcm.writeInt16LE(Math.round(Math.sin(phase) * envelope * GAIN * 32767), i * 2);
}

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

const out = path.join(__dirname, '..', 'media', 'blip.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`Wrote ${out}`);
