// Generates the SimonStays "booking confirmed" sound: a warm thump, a rising
// bell arpeggio (E major), a sparkle of coins and a soft ringing tail, ~1.7 s.
// Run: node scripts/make-booking-sound.js
// Writes a 44.1 kHz 16-bit mono WAV to:
//   server/public/sounds/simonstays-booking.wav  (served at /sounds/…, played by Hosting)
//   mobile/assets/sounds/simonstays-booking.wav  (for the app's notification sound later)
const fs = require('fs');
const path = require('path');

const RATE = 44100;
const LEN = 1.7; // seconds
const N = Math.round(RATE * LEN);
const out = new Float32Array(N);

// Deterministic "random" so the file is the same every time it's made.
let seed = 20261106;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// A bell: a few inharmonic partials, each fading at its own rate.
function bell(t0, freq, amp, decay = 1.1) {
  const partials = [[1, 1, 1], [2.0, 0.45, 1.6], [2.76, 0.28, 2.2], [5.4, 0.12, 3.5], [8.93, 0.05, 5]];
  const start = Math.round(t0 * RATE);
  for (const [ratio, a, d] of partials) {
    const f = freq * ratio, k = d / decay;
    for (let i = start; i < N; i++) {
      const t = (i - start) / RATE;
      const env = Math.min(1, t / 0.004) * Math.exp(-k * 3 * t); // 4 ms attack
      if (t > 0.01 && env < 1e-4) break; // (not during the attack, where env starts at 0)
      out[i] += amp * a * env * Math.sin(2 * Math.PI * f * t + ratio);
    }
  }
}

// A soft low thump under the first note, for weight.
function thump(t0) {
  const start = Math.round(t0 * RATE);
  for (let i = start; i < Math.min(N, start + RATE * 0.25); i++) {
    const t = (i - start) / RATE;
    const f = 140 - 60 * Math.min(1, t / 0.08); // pitch drops 140 → 80 Hz
    out[i] += 0.18 * Math.exp(-t * 26) * Math.sin(2 * Math.PI * f * t);
  }
}

// Coin sparkle: short, very high pings scattered over a moment.
function sparkle(t0, count, spread) {
  for (let c = 0; c < count; c++) {
    const t = t0 + rnd() * spread;
    const f = 3800 + rnd() * 4200;
    const start = Math.round(t * RATE);
    const amp = 0.05 + rnd() * 0.06;
    for (let i = start; i < Math.min(N, start + RATE * 0.12); i++) {
      const tt = (i - start) / RATE;
      out[i] += amp * Math.exp(-tt * 45) * Math.sin(2 * Math.PI * f * tt);
    }
  }
}

// E6, G#6, B6, E7: a bright, rising "you've got money" phrase.
thump(0);
bell(0.00, 1318.51, 0.30);
bell(0.075, 1661.22, 0.28);
bell(0.15, 1975.53, 0.27);
bell(0.235, 2637.02, 0.34, 3.2); // the top note rings longest
sparkle(0.24, 26, 0.38);
bell(0.24, 659.25, 0.14, 3.5); // a low E under the top note keeps it warm

// Fade the last 120 ms, then normalise to -1 dBFS.
const fade = Math.round(RATE * 0.12);
for (let i = 0; i < fade; i++) out[N - 1 - i] *= i / fade;
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
const gain = (10 ** (-1 / 20)) / peak;

const data = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * gain * 32767))), i * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(data.length, 40);
const wav = Buffer.concat([header, data]);

for (const dir of [path.join(__dirname, '../public/sounds'), path.join(__dirname, '../../mobile/assets/sounds')]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'simonstays-booking.wav'), wav);
  console.log('wrote', path.join(dir, 'simonstays-booking.wav'), `${(wav.length / 1024).toFixed(0)} KB`);
}
