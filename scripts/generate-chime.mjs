#!/usr/bin/env node
// Generates the serene prayer notification chime (audio/chime.mp3).
//
// Synthesizes a 3-strike harmonic chime (E5 -> B5 -> E6) with natural acoustic
// bell overtones (1x, 2x, 2.76x, 3x, 4.07x, 5.4x), subtle stereo panning,
// 6ms gentle attack, and exponential decay over 2.8 seconds.
//
// Requires ffmpeg (or afconvert on macOS) to encode the PCM WAV to a compact MP3.

import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_DIR = join(REPO, 'audio');
const WAV_PATH = join(AUDIO_DIR, 'chime.wav');
const MP3_PATH = join(AUDIO_DIR, 'chime.mp3');

const sampleRate = 44100;
const duration = 2.8;
const totalSamples = Math.floor(sampleRate * duration);

const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);

// 3 chime strikes: E5 (659.25 Hz), B5 (987.77 Hz), E6 (1318.51 Hz)
const notes = [
  { time: 0.00, freq: 659.25, dur: 2.4, gain: 0.65, pan: -0.2 },
  { time: 0.35, freq: 987.77, dur: 2.3, gain: 0.75, pan: 0.2 },
  { time: 0.70, freq: 1318.51, dur: 2.1, gain: 0.80, pan: 0.0 },
];

for (const note of notes) {
  const startIdx = Math.floor(note.time * sampleRate);
  const noteSamples = Math.floor(note.dur * sampleRate);

  for (let i = 0; i < noteSamples && (startIdx + i) < totalSamples; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1.0, t / 0.006); // 6ms gentle attack
    const decay = Math.exp(-2.6 * t); // natural bell decay
    const env = attack * decay * note.gain;

    // Rich bell harmonics
    const f = note.freq;
    const tone =
      Math.sin(2 * Math.PI * f * 1.0 * t) * 0.60 +
      Math.sin(2 * Math.PI * f * 2.0 * t) * 0.22 +
      Math.sin(2 * Math.PI * f * 2.76 * t) * 0.12 +
      Math.sin(2 * Math.PI * f * 3.0 * t) * 0.08 +
      Math.sin(2 * Math.PI * f * 4.07 * t) * 0.05 +
      Math.sin(2 * Math.PI * f * 5.4 * t) * 0.03;

    const sampleVal = tone * env;
    const panL = 0.5 * (1 - note.pan);
    const panR = 0.5 * (1 + note.pan);

    left[startIdx + i] += sampleVal * panL;
    right[startIdx + i] += sampleVal * panR;
  }
}

// Peak normalize to -1 dB (0.89)
let maxPeak = 0;
for (let i = 0; i < totalSamples; i++) {
  const p = Math.max(Math.abs(left[i]), Math.abs(right[i]));
  if (p > maxPeak) maxPeak = p;
}
const scale = maxPeak > 0 ? 0.89 / maxPeak : 1;

// Write 16-bit stereo WAV buffer
const buffer = Buffer.alloc(44 + totalSamples * 4);
buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + totalSamples * 4, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20); // PCM
buffer.writeUInt16LE(2, 22); // stereo
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 4, 28);
buffer.writeUInt16LE(4, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(totalSamples * 4, 40);

for (let i = 0; i < totalSamples; i++) {
  const l = Math.max(-1, Math.min(1, left[i] * scale));
  const r = Math.max(-1, Math.min(1, right[i] * scale));
  buffer.writeInt16LE(Math.floor(l * 32767), 44 + i * 4);
  buffer.writeInt16LE(Math.floor(r * 32767), 44 + i * 4 + 2);
}

mkdirSync(AUDIO_DIR, { recursive: true });
writeFileSync(WAV_PATH, buffer);

// Convert to MP3
try {
  execFileSync('ffmpeg', ['-y', '-i', WAV_PATH, '-codec:a', 'libmp3lame', '-b:a', '128k', MP3_PATH], { stdio: 'pipe' });
  unlinkSync(WAV_PATH);
  console.log(`✓ Generated ${MP3_PATH}`);
} catch (e) {
  console.error('ffmpeg conversion failed:', e.message);
  process.exit(1);
}
