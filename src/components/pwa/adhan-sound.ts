"use client";

import * as React from "react";
import { readLocalJson, useLocalJson } from "./local-store";
import { ADHAN_VIBRATE, REMINDER_VIBRATE } from "./reminder-message";

export { ADHAN_VIBRATE, REMINDER_VIBRATE };

/**
 * Suara khas pengingat di dalam App (PRD-07b):
 * - pilihan suara (adzan penuh / jingle khas Al Muttaqin / getar saja / senyap) dan volume di localStorage,
 * - SATU elemen <audio> dipakai untuk adzan maupun jingle. Elemen itu "dibuka" sekali lewat
 *   pemutaran senyap di dalam gestur pengguna yang sah (touchend / click / keydown; BUKAN
 *   pointerdown, yang untuk sentuhan tidak dihitung gestur oleh Safari & Chrome). Setelah terbuka,
 *   browser mengizinkan elemen yang sama berbunyi otomatis tepat pada waktu adzan, termasuk di PWA
 *   yang terpasang. Bila tetap diblokir, banner menampilkan tombol Putar.
 * - Web Audio hanya cadangan bila berkas jingle gagal dimuat,
 * - Media Session: judul pengingat & tombol berhenti tampil di layar kunci / bilah notifikasi,
 * - status banner (external store untuk useSyncExternalStore).
 *
 * Catatan: suara kustom tidak didukung untuk notifikasi push saat App tertutup; perangkat memakai
 * suara notifikasi standarnya.
 */

/** "chime" = jingle khas Al Muttaqin (nama kunci lama dipertahankan agar pengaturan tersimpan tetap berlaku). */
export type SoundMode = "adhan" | "chime" | "vibrate" | "silent";
export const SOUND_MODES: SoundMode[] = ["adhan", "chime", "vibrate", "silent"];
export type SoundSettings = { mode: SoundMode; volume: number };

export const SOUND_PREFS_KEY = "acc-adhan-sound";
export const DEFAULT_SOUND: SoundSettings = { mode: "adhan", volume: 0.8 };

type Source = { src: string; type: string };
/** Rekaman adzan (lihat public/audio/CREDITS.md). MP3 untuk semua browser termasuk iOS, OGG cadangan. */
const ADHAN_SOURCES: Source[] = [
  { src: "/audio/adhan-madinah.mp3", type: "audio/mpeg" },
  { src: "/audio/adhan-madinah.ogg", type: "audio/ogg" },
];
/** Jingle khas (scripts/generate-notification-assets.mjs). AAC kecil, WAV cadangan universal. */
const JINGLE_SOURCES: Source[] = [
  { src: "/audio/notify-jingle.m4a", type: 'audio/mp4; codecs="mp4a.40.2"' },
  { src: "/audio/notify-jingle.wav", type: "audio/wav" },
];

export function normalizeSound(raw: unknown): SoundSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode = SOUND_MODES.includes(r.mode as SoundMode) ? (r.mode as SoundMode) : DEFAULT_SOUND.mode;
  const volume = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : DEFAULT_SOUND.volume;
  return { mode, volume };
}

export function readSoundSettings(): SoundSettings {
  return normalizeSound(readLocalJson<unknown>(SOUND_PREFS_KEY, null));
}

export function useSoundSettings(): [SoundSettings, (next: SoundSettings) => void] {
  const [raw, set] = useLocalJson<unknown>(SOUND_PREFS_KEY, null);
  const value = React.useMemo(() => normalizeSound(raw), [raw]);
  return [value, set];
}

// ---------------------------------------------------------------
// Status banner / pemutaran
// ---------------------------------------------------------------

export type AlertSound = "adhan" | "jingle" | "none";
export type AlertKind = "adhan" | "iqamah" | "jumuah" | "test" | "broadcast";

export type AlertState =
  | { status: "idle" }
  | {
      /** playing: suara berbunyi; blocked: browser menolak autoplay; shown: tanpa suara / selesai. */
      status: "playing" | "blocked" | "shown";
      /** alert: banner pengingat; preview: pratinjau dari Pengaturan (tanpa banner). */
      source: "alert" | "preview";
      sound: AlertSound;
      kind: AlertKind;
      title: string;
      body: string;
      tag: string;
      /** Tautan tujuan tombol "Buka" di banner (mis. jadwal salat atau URL pengumuman). */
      url?: string;
    };

const IDLE: AlertState = { status: "idle" };
let state: AlertState = IDLE;
const listeners = new Set<() => void>();

function setState(next: AlertState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAdhanAlert(): AlertState {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => IDLE,
  );
}

// ---------------------------------------------------------------
// Status "audio sudah dibuka" (untuk petunjuk "ketuk sekali" di App)
// ---------------------------------------------------------------

let unlocked = false;
const unlockListeners = new Set<() => void>();

function setUnlocked(next: boolean) {
  if (unlocked === next) return;
  unlocked = next;
  for (const l of unlockListeners) l();
}

function subscribeUnlock(cb: () => void): () => void {
  unlockListeners.add(cb);
  return () => unlockListeners.delete(cb);
}

/** true bila browser sudah mengizinkan App berbunyi otomatis. Server/hidrasi: true (tanpa kedip petunjuk). */
export function useAudioUnlocked(): boolean {
  return React.useSyncExternalStore(
    subscribeUnlock,
    () => unlocked,
    () => true,
  );
}

// ---------------------------------------------------------------
// Audio
// ---------------------------------------------------------------

type AudioCtor = typeof AudioContext;
let player: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let synthGain: GainNode | null = null;
let synthTimer: number | undefined;
/** Jenis sesi audio sebelum cadangan Web Audio mengubahnya ke "playback" (dipulihkan sesudahnya). */
let prevSessionType: string | null = null;
/** Penanda pemutaran terbaru agar callback lama (ended/catch) tidak menimpa status baru. */
let playToken = 0;

function getPlayer(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  if (!player) {
    const el = new Audio();
    // Jangan mengunduh adzan (3 MB) sebelum dibutuhkan; jingle kecil dipasang saat audio dibuka.
    el.preload = "none";
    el.setAttribute("playsinline", "");
    el.setAttribute("x-webkit-airplay", "deny");
    player = el;
  }
  return player;
}

function pickSource(el: HTMLAudioElement, sources: Source[]): string {
  return (sources.find((s) => el.canPlayType(s.type) !== "") ?? sources[0]).src;
}

function setSource(el: HTMLAudioElement, url: string) {
  const abs = new URL(url, window.location.href).href;
  if (el.src !== abs) el.src = url;
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor: AudioCtor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/** Ada pemutar media lain di halaman yang sedang berbunyi (murottal, video)? */
function otherMediaPlaying(): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video")).some((m) => m !== player && !m.paused);
}

/**
 * Dipanggil di dalam gestur pengguna (touchend / click / keydown): memutar elemen audio secara
 * senyap sesaat agar pemutaran berikutnya (saat waktu adzan) diizinkan browser, termasuk Safari iOS
 * dan PWA terpasang. Senyap (muted) agar musik dari aplikasi lain tidak terhenti. Dilewati bila
 * ketukan mengenai pemutar media lain atau ada media lain yang sedang berbunyi, karena di iOS
 * memutar elemen audio kedua menghentikan murottal.
 */
export function unlockAudio(target?: EventTarget | null): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Element !== "undefined" && target instanceof Element && target.closest("[data-media-player], audio, video, iframe")) return unlocked;
  const ctx = getCtx();
  if (ctx && ctx.state !== "running") void ctx.resume().catch(() => undefined);
  if (unlocked) return true;
  if (otherMediaPlaying()) return false;
  const el = getPlayer();
  if (!el) return false;
  if (state.status === "playing") {
    setUnlocked(true);
    return true;
  }
  setSource(el, pickSource(el, JINGLE_SOURCES));
  el.muted = true;
  setUnlocked(true);
  el.play()
    .then(() => {
      if (state.status !== "playing") {
        el.pause();
        try {
          el.currentTime = 0;
        } catch {
          // abaikan
        }
      }
      el.muted = false;
    })
    .catch(() => {
      el.muted = false;
      setUnlocked(false);
    });
  return true;
}

let unlockInstalled = false;

/**
 * Pasang pendengar gestur sekali untuk seluruh sesi halaman. Tidak pernah dilepas: bila browser
 * mencabut izin (mis. setelah App lama di latar belakang), ketukan berikutnya membukanya lagi.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  const opts = { capture: true, passive: true } as const;
  const onGesture = (e: Event) => {
    if (e instanceof KeyboardEvent && (e.key === "Escape" || e.repeat)) return;
    unlockAudio(e.target);
  };
  for (const ev of ["touchend", "click", "keydown"] as const) window.addEventListener(ev, onGesture, opts);
}

function audioSession(): { type: string } | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
}

/** Pulihkan jenis sesi audio iOS agar musik dari aplikasi lain tidak terus terhenti oleh App. */
function releaseAudioSession() {
  try {
    const session = audioSession();
    if (session && prevSessionType !== null) session.type = prevSessionType;
  } catch {
    // abaikan
  }
  prevSessionType = null;
}

function stopSynth() {
  window.clearTimeout(synthTimer);
  releaseAudioSession();
  if (synthGain && audioCtx) {
    const now = audioCtx.currentTime;
    try {
      synthGain.gain.cancelScheduledValues(now);
      synthGain.gain.setValueAtTime(synthGain.gain.value, now);
      synthGain.gain.linearRampToValueAtTime(0, now + 0.08);
    } catch {
      // abaikan
    }
  }
  synthGain = null;
}

function stopAudio() {
  if (player) {
    player.onended = null;
    player.pause();
    // Lepas sumbernya: Chrome menghapus pemutar dari sesi media, sehingga tidak tertinggal
    // notifikasi media dengan tombol Putar setelah adzan dihentikan. Elemen tetap "terbuka".
    if (player.hasAttribute("src")) {
      player.removeAttribute("src");
      player.load();
    }
  }
  stopSynth();
  clearMediaSession();
}

/** Satu nada petik/lonceng: beberapa parsial sinus dengan peluruhan eksponensial. */
function tone(ctx: AudioContext, dest: AudioNode, freq: number, start: number, duration: number, amp = 1) {
  const partials: [number, number][] = [
    [1, 1],
    [2.01, 0.3],
    [3.02, 0.12],
  ];
  for (const [ratio, a] of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * ratio;
    const end = start + duration / Math.sqrt(ratio);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(a * amp, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(dest);
    osc.start(start);
    osc.stop(end + 0.05);
  }
}

/** Cadangan Web Audio: motif Hijaz yang sama dengan berkas jingle. Mengembalikan durasi (ms) atau null bila diblokir. */
async function playSynthJingle(volume: number): Promise<number | null> {
  const ctx = getCtx();
  if (!ctx) return null;
  // iOS 17+: kategori "playback" agar tetap berbunyi walau sakelar senyap aktif (dipulihkan di stopSynth).
  try {
    const session = audioSession();
    if (session) {
      if (prevSessionType === null) prevSessionType = session.type || "auto";
      session.type = "playback";
    }
  } catch {
    // abaikan
  }
  if (ctx.state !== "running") {
    try {
      await ctx.resume();
    } catch {
      return null;
    }
  }
  if (ctx.state !== "running") return null;
  stopSynth();
  const master = ctx.createGain();
  master.gain.value = Math.max(0.0001, volume) * 0.4;
  master.connect(ctx.destination);
  synthGain = master;
  const t0 = ctx.currentTime + 0.03;
  const notes: [number, number, number][] = [
    [0, 293.66, 0.5],
    [0.16, 311.13, 0.5],
    [0.32, 369.99, 0.5],
    [0.48, 392.0, 0.7],
    [0.8, 440.0, 1.2],
    [1.38, 466.16, 0.4],
    [1.52, 440.0, 0.8],
    [1.95, 369.99, 0.5],
    [2.13, 392.0, 0.5],
    [2.32, 293.66, 2.2],
  ];
  for (const [at, f, d] of notes) tone(ctx, master, f, t0 + at, d);
  tone(ctx, master, 587.33, t0 + 2.34, 1.8, 0.35);
  return 4300;
}

function vibrate(pattern: number[]) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {
    // abaikan
  }
}

// ---------------------------------------------------------------
// Media Session (layar kunci / bilah notifikasi)
// ---------------------------------------------------------------

let ownMetadata: MediaMetadata | null = null;

function setMediaSession(title: string) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  try {
    ownMetadata = new MediaMetadata({
      title,
      artist: "Al Muttaqin Cultural Center",
      artwork: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
    navigator.mediaSession.metadata = ownMetadata;
    navigator.mediaSession.setActionHandler("pause", () => stopAlertSound());
    navigator.mediaSession.setActionHandler("stop", () => stopAlertSound());
  } catch {
    // abaikan
  }
}

function clearMediaSession() {
  if (!ownMetadata || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    // Jangan menghapus sesi milik pemutar lain (murottal) yang dimulai sesudahnya.
    if (navigator.mediaSession.metadata === ownMetadata) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("stop", null);
    }
  } catch {
    // abaikan
  }
  ownMetadata = null;
}

// ---------------------------------------------------------------
// Pemutaran pengingat
// ---------------------------------------------------------------

type AlertInput = { title: string; body: string; tag: string; kind: AlertKind; url?: string };

function resolveSound(kind: AlertKind, mode: SoundMode): AlertSound {
  if (mode === "silent" || mode === "vibrate") return "none";
  if (mode === "adhan" && (kind === "adhan" || kind === "test")) return "adhan";
  return "jingle";
}

function markShown(token: number) {
  if (token === playToken && state.status === "playing") setState({ ...state, status: "shown" });
  clearMediaSession();
  if (token === playToken) releaseAudioSession();
}

/**
 * Hasil membunyikan pengingat: played = suara benar-benar berbunyi; blocked = browser menolak
 * (belum ada ketukan) sehingga pemanggil sebaiknya menampilkan notifikasi sistem yang bersuara;
 * none = pengguna memilih getar/senyap; stale = digantikan pengingat lain.
 */
export type AlertOutcome = "played" | "blocked" | "none" | "stale";

async function playFile(sources: Source[], volume: number, token: number, title: string): Promise<"ok" | "blocked" | "failed" | "stale"> {
  const el = getPlayer();
  if (!el) return "failed";
  stopSynth();
  setSource(el, pickSource(el, sources));
  el.preload = "auto";
  el.loop = false;
  el.volume = volume;
  el.muted = false;
  try {
    el.currentTime = 0;
  } catch {
    // abaikan (belum ada metadata)
  }
  el.onended = () => markShown(token);
  try {
    await el.play();
    if (token !== playToken) return "stale";
    setUnlocked(true);
    setMediaSession(title);
    return "ok";
  } catch (err) {
    if (token !== playToken) return "stale";
    const name = (err as { name?: string } | null)?.name;
    if (name === "NotAllowedError") {
      setUnlocked(false);
      return "blocked";
    }
    return "failed";
  }
}

async function startSound(sound: AlertSound, volume: number, token: number): Promise<AlertOutcome> {
  if (sound === "none") {
    if (token === playToken && state.status !== "idle") setState({ ...state, status: "shown" });
    return "none";
  }
  const title = state.status === "idle" ? "Al Muttaqin" : state.title;
  // Adzan gagal dimuat (mis. offline & belum tersimpan): jatuh ke jingle, lalu ke Web Audio.
  const order = sound === "adhan" ? [ADHAN_SOURCES, JINGLE_SOURCES] : [JINGLE_SOURCES];
  for (const sources of order) {
    const result = await playFile(sources, volume, token, title);
    if (result === "ok") return "played";
    if (result === "stale") return "stale";
    if (result === "blocked") {
      if (state.status !== "idle") setState({ ...state, status: "blocked" });
      return "blocked";
    }
  }
  const ms = await playSynthJingle(volume);
  if (token !== playToken || state.status === "idle") {
    if (token === playToken) stopSynth();
    return "stale";
  }
  if (ms === null) {
    releaseAudioSession();
    setState({ ...state, status: "blocked" });
    return "blocked";
  }
  synthTimer = window.setTimeout(() => markShown(token), ms);
  return "played";
}

/** Tampilkan banner pengingat dan bunyikan suara khas sesuai pengaturan; hasilnya menyatakan apakah benar-benar berbunyi. */
export function triggerAlert(input: AlertInput, settings: SoundSettings = readSoundSettings()): Promise<AlertOutcome> {
  stopAudio();
  const token = ++playToken;
  const sound = resolveSound(input.kind, settings.mode);
  if (settings.mode !== "silent") vibrate(input.kind === "adhan" ? ADHAN_VIBRATE : REMINDER_VIBRATE);
  setState({ status: sound === "none" ? "shown" : "playing", source: "alert", sound, ...input });
  return startSound(sound, settings.volume, token);
}

/** Pratinjau suara dari Pengaturan (tanpa banner). Dipanggil dari ketukan, jadi sekaligus membuka audio. */
export function previewSound(settings: SoundSettings, labels: { title: string; body: string }): void {
  stopAudio();
  const token = ++playToken;
  const sound = resolveSound("test", settings.mode);
  if (settings.mode === "vibrate") vibrate(ADHAN_VIBRATE);
  if (sound === "none") {
    setState(IDLE);
    return;
  }
  setState({ status: "playing", source: "preview", sound, kind: "test", tag: "acc-preview", ...labels });
  void startSound(sound, settings.volume, token);
}

/** Ubah volume pemutaran yang sedang berjalan. */
export function setPlayingVolume(volume: number): void {
  if (player) player.volume = Math.min(1, Math.max(0, volume));
  if (synthGain) synthGain.gain.value = Math.max(0.0001, volume) * 0.4;
}

/** Hentikan suara; banner tetap tampil (status "shown") sampai ditutup. */
export function stopAlertSound(): void {
  playToken++;
  stopAudio();
  if (state.status === "idle") return;
  if (state.source === "preview") setState(IDLE);
  else setState({ ...state, status: "shown" });
}

/** Coba putar lagi setelah diblokir (dipanggil dari ketukan pengguna). */
export function retryAlertSound(): void {
  if (state.status === "idle") return;
  const token = ++playToken;
  const settings = readSoundSettings();
  const sound: AlertSound = state.sound === "none" ? "jingle" : state.sound;
  setState({ ...state, sound, status: "playing" });
  void startSound(sound, settings.volume, token);
}

export function dismissAlert(): void {
  playToken++;
  stopAudio();
  setState(IDLE);
}

/** Notifikasi sistem untuk tag ini ditutup: hentikan suaranya bila masih berbunyi di App. */
export function dismissAlertForTag(tag: string): void {
  if (state.status !== "idle" && state.tag === tag) dismissAlert();
}

const warmed = new Set<string>();

/**
 * Unduh suara sekali (respons 200 penuh) agar disimpan cache service worker dan tetap berbunyi
 * saat offline: jingle selalu (kecil), adzan hanya bila mode adzan dipilih.
 */
export function warmAlertSounds(mode: SoundMode): void {
  if (typeof window === "undefined" || typeof fetch === "undefined" || mode === "silent" || mode === "vibrate") return;
  const el = getPlayer();
  if (!el) return;
  const urls = [pickSource(el, JINGLE_SOURCES), ...(mode === "adhan" ? [pickSource(el, ADHAN_SOURCES)] : [])];
  for (const url of urls) {
    if (warmed.has(url)) continue;
    warmed.add(url);
    void fetch(url, { cache: "force-cache" }).catch(() => warmed.delete(url));
  }
}
