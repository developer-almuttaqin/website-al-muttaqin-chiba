import type { ObligatoryPrayer } from "@/lib/types";

/**
 * Bentuk pesan push pengingat yang dipakai bersama server (/api/push/send), service worker
 * (src/app/sw.ts), dan halaman App. Sengaja tanpa impor runtime agar bundel SW tetap kecil.
 */
export type ReminderPushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** "iqamah" hanya dikirim versi lama; sekarang satu notifikasi per waktu salat (adzan / Jumat). */
  kind?: "adhan" | "iqamah" | "jumuah" | "broadcast" | "test";
  prayer?: ObligatoryPrayer;
  /** Waktu kejadian (ISO UTC): adzan, atau mulai Jumatan. */
  at?: string;
  /** Waktu notifikasi seharusnya tampil (ISO UTC); Jumat = `at` - 30 menit. Dasar penilaian "baru". */
  notifyAt?: string;
  /** Label tombol aksi notifikasi dalam bahasa pelanggan. */
  actions?: { open: string; dismiss: string };
};

/**
 * Pesan service worker ke jendela App yang terlihat: putar suara khas & tampilkan banner.
 * Halaman menjawab lewat MessagePort dengan `SwReminderReply`; SW hanya melewatkan / menyenyapkan
 * notifikasi sistem bila halaman benar-benar menanganinya (suara berbunyi, atau pengguna memilih senyap).
 */
export const SW_REMINDER_MESSAGE = "acc-reminder";
export type SwReminderMessage = { type: typeof SW_REMINDER_MESSAGE; payload: ReminderPushPayload; receivedAt: number };
export type SwReminderReply = { handled: boolean };
/** Batas tunggu jawaban halaman sebelum SW menampilkan notifikasi bersuara biasa. */
export const SW_REPLY_TIMEOUT_MS = 2500;

/** Halaman App (yang memasang pendengar pengingat): /ja/app, /en/app/..., /id/app/... */
export const APP_PATH = /^\/(ja|en|id)\/app(\/|$)/;

/** Waktu acuan "baru" sebuah payload: notifyAt, lalu at, lalu null. */
export function payloadNotifyTime(payload: Pick<ReminderPushPayload, "at" | "notifyAt">): number | null {
  const raw = payload.notifyAt ?? payload.at;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Notifikasi ditutup / tombol Tutup diketuk: hentikan suara yang sedang berbunyi untuk tag ini. */
export const SW_REMINDER_STOP = "acc-reminder-stop";
export type SwReminderStopMessage = { type: typeof SW_REMINDER_STOP; tag: string };

/** Jendela tidak bisa dinavigasikan oleh SW (belum dikendalikan): halaman pindah sendiri. */
export const SW_NAVIGATE = "acc-navigate";
export type SwNavigateMessage = { type: typeof SW_NAVIGATE; url: string };

/** Ikon besar dan badge monokrom (siluet kubah, untuk bilah status Android) notifikasi. */
export const NOTIFY_ICON = "/icons/icon-192.png";
export const NOTIFY_BADGE = "/icons/badge-96.png";

/** Pola getar khas: adzan lebih panjang, pengingat lain singkat. */
export const ADHAN_VIBRATE = [600, 250, 600, 250, 900];
export const REMINDER_VIBRATE = [250, 120, 250];

/** Kejadian pengingat dianggap "baru" (boleh berbunyi di App) bila tiba paling lambat sekian setelah waktunya. */
export const REMINDER_FRESH_MS = 3 * 60_000;

/** Jenis notifikasi waktu salat (paling banyak satu yang tampil sekaligus). */
export function isPrayerKind(kind: ReminderPushPayload["kind"]): kind is "adhan" | "iqamah" | "jumuah" {
  return kind === "adhan" || kind === "iqamah" || kind === "jumuah";
}
