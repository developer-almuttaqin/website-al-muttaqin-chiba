// Membuat aset notifikasi khas Al Muttaqin (komposisi & sintesis asli, tanpa sampel pihak lain):
//   public/audio/notify-jingle.wav  jingle notifikasi ~3,6 detik (22,05 kHz mono 16-bit, cadangan universal)
//   public/audio/notify-jingle.m4a  versi AAC kecil (dibuat bila `afconvert` (macOS) atau `ffmpeg` tersedia)
//   public/icons/badge-96.png       badge monokrom (siluet kubah putih transparan) untuk bilah status Android
// Jalankan: node scripts/generate-notification-assets.mjs
//
// Jingle: motif maqam Hijaz pada D (D Eb F# G A Bb), dipetik dengan timbre ala qanun (Karplus-Strong),
// ketukan daf lembut, dan dengung (drone) D rendah, lalu gema ringan. Deterministik (PRNG berbenih).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = process.cwd();
const audioDir = join(root, "public", "audio");
const iconDir = join(root, "public", "icons");
mkdirSync(audioDir, { recursive: true });
mkdirSync(iconDir, { recursive: true });

// ---------------------------------------------------------------------------
// Jingle
// ---------------------------------------------------------------------------
const SR = 22050;
const DURATION = 3.6;
const N = Math.round(SR * DURATION);
const out = new Float32Array(N);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xacc1);

const D4 = 293.66;
const NOTE = { D3: 146.83, D4, Eb4: 311.13, Fs4: 369.99, G4: 392.0, A4: 440.0, Bb4: 466.16, D5: 587.33, A5: 880.0 };

/** Senar dipetik (Karplus-Strong) dengan sedikit parsial sinus agar hangat. */
function pluck(freq, start, dur, gain, bright = 0.5) {
  const s0 = Math.round(start * SR);
  const len = Math.min(N - s0, Math.round((dur + 1.4) * SR));
  const period = Math.max(2, Math.round(SR / freq));
  const buf = new Float32Array(period);
  for (let i = 0; i < period; i++) buf[i] = rand() * 2 - 1;
  // Haluskan derau awal (petikan lebih lembut, bukan tajam).
  for (let pass = 0; pass < 2; pass++) for (let i = 1; i < period; i++) buf[i] = buf[i] * bright + buf[i - 1] * (1 - bright);
  let idx = 0;
  const decay = 0.9965;
  const releaseAt = Math.round(dur * SR);
  for (let i = 0; i < len; i++) {
    const cur = buf[idx];
    const next = buf[(idx + 1) % period];
    buf[idx] = decay * 0.5 * (cur + next);
    idx = (idx + 1) % period;
    const t = i / SR;
    const attack = Math.min(1, i / (0.004 * SR));
    const release = i > releaseAt ? Math.exp(-(i - releaseAt) / (0.35 * SR)) : 1;
    const body = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 3.2) * 0.35;
    out[s0 + i] += (cur * 0.8 + body) * gain * attack * release;
  }
}

/** Lonceng lembut (parsial inharmonis) untuk kilau di nada akhir. */
function bell(freq, start, dur, gain) {
  const s0 = Math.round(start * SR);
  const len = Math.min(N - s0, Math.round(dur * SR));
  const partials = [
    [1, 1],
    [2.01, 0.32],
    [3.02, 0.12],
    [4.18, 0.05],
  ];
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (const [ratio, amp] of partials) v += Math.sin(2 * Math.PI * freq * ratio * t) * amp * Math.exp((-t * 2.4 * Math.sqrt(ratio)) / Math.max(0.5, dur / 2));
    out[s0 + i] += v * gain * Math.min(1, i / (0.01 * SR));
  }
}

/** Ketukan daf lembut: sinus rendah dengan penurunan nada + derau tipis. */
function daf(start, gain) {
  const s0 = Math.round(start * SR);
  const len = Math.min(N - s0, Math.round(0.45 * SR));
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 70 + 90 * Math.exp(-t * 28);
    phase += (2 * Math.PI * f) / SR;
    lp += 0.08 * (rand() * 2 - 1 - lp);
    const tone = Math.sin(phase) * Math.exp(-t * 9);
    const skin = lp * Math.exp(-t * 38) * 0.6;
    out[s0 + i] += (tone + skin) * gain;
  }
}

/** Dengung D rendah sepanjang jingle. */
function drone(freq, start, end, gain) {
  const s0 = Math.round(start * SR);
  const s1 = Math.min(N, Math.round(end * SR));
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR;
    const env = Math.min(1, t / 0.5) * Math.min(1, (s1 - i) / (0.9 * SR));
    const v = Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2 * t) + 0.12 * Math.sin(2 * Math.PI * freq * 3 * t);
    out[i] += v * gain * env;
  }
}

// Melodi: naik D Eb F# G (ciri Hijaz), aksen A dengan hiasan Bb, lalu turun pulang ke D.
const melody = [
  [0.0, NOTE.D4, 0.16, 0.5],
  [0.16, NOTE.Eb4, 0.16, 0.5],
  [0.32, NOTE.Fs4, 0.16, 0.52],
  [0.48, NOTE.G4, 0.3, 0.55],
  [0.8, NOTE.A4, 0.55, 0.62],
  [1.38, NOTE.Bb4, 0.14, 0.42],
  [1.52, NOTE.A4, 0.4, 0.55],
  [1.95, NOTE.Fs4, 0.18, 0.48],
  [2.13, NOTE.G4, 0.18, 0.5],
  [2.32, NOTE.D4, 1.0, 0.66],
];
for (const [t, f, d, g] of melody) pluck(f, t, d, g, 0.55);
pluck(NOTE.D5, 2.32, 1.0, 0.22, 0.7);
bell(NOTE.D5, 2.34, 1.2, 0.1);
bell(NOTE.A5, 2.36, 0.9, 0.04);
daf(0.0, 0.42);
daf(0.8, 0.26);
daf(2.32, 0.4);
drone(NOTE.D3, 0.0, DURATION, 0.07);

// Gema ringan (Schroeder: 4 comb paralel + 2 allpass seri).
function reverb(input, mix) {
  const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round((d * SR) / 44100)), i: 0, fb: 0.78, lp: 0 }));
  const aps = [556, 441].map((d) => ({ buf: new Float32Array(Math.round((d * SR) / 44100)), i: 0 }));
  const res = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const x = input[n];
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.lp = o * 0.7 + c.lp * 0.3;
      c.buf[c.i] = x + c.lp * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    y /= combs.length;
    for (const a of aps) {
      const o = a.buf[a.i];
      const v = y + o * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.buf.length;
      y = o - v * 0.5;
    }
    res[n] = x * (1 - mix) + y * mix;
  }
  return res;
}
const wet = reverb(out, 0.22);

// Normalisasi ke -1 dBFS, potong DC, dan fade-out akhir.
let mean = 0;
for (const v of wet) mean += v;
mean /= wet.length;
let peak = 0;
for (let i = 0; i < wet.length; i++) {
  wet[i] -= mean;
  peak = Math.max(peak, Math.abs(wet[i]));
}
const target = 10 ** (-1 / 20);
const fadeStart = N - Math.round(0.35 * SR);
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  let v = (wet[i] / peak) * target;
  if (i > fadeStart) v *= 1 - (i - fadeStart) / (N - fadeStart);
  if (i < 64) v *= i / 64;
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
}

function wav(data, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const wavPath = join(audioDir, "notify-jingle.wav");
const m4aPath = join(audioDir, "notify-jingle.m4a");
writeFileSync(wavPath, wav(pcm, SR));
console.log(`public/audio/notify-jingle.wav  ${DURATION}s`);

function tryEncode() {
  if (existsSync(m4aPath)) rmSync(m4aPath);
  try {
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", wavPath, m4aPath], { stdio: "ignore" });
    return "afconvert";
  } catch {
    // bukan macOS
  }
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wavPath, "-c:a", "aac", "-b:a", "64k", m4aPath], { stdio: "ignore" });
    return "ffmpeg";
  } catch {
    return null;
  }
}
const encoder = tryEncode();
console.log(encoder ? `public/audio/notify-jingle.m4a  (${encoder})` : "Lewati .m4a: pasang ffmpeg atau jalankan di macOS (afconvert). .wav tetap dipakai sebagai cadangan.");

// ---------------------------------------------------------------------------
// Badge notifikasi monokrom
// ---------------------------------------------------------------------------
const SIZE = 96;
const markPath = join(root, "public", "images", "brand", "logo-mark.png");
const inner = Math.round(SIZE * 0.78);
const resized = await sharp(markPath).resize({ width: inner, height: inner, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { data, info } = resized;
for (let i = 0; i < data.length; i += 4) {
  data[i] = 255;
  data[i + 1] = 255;
  data[i + 2] = 255;
}
const glyph = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: glyph, gravity: "center" }])
  .png({ compressionLevel: 9 })
  .toFile(join(iconDir, "badge-96.png"));
console.log("public/icons/badge-96.png");
