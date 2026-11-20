import type { GeoPoint, Locale, ObligatoryPrayer, PrayerConfig } from "@/lib/types";
import { OBLIGATORY_PRAYERS, getPrayerTimesToday } from "@/lib/prayer";
import { addDays, formatTime, parseTokyoDate } from "@/lib/utils/i18n";

/**
 * Preferensi notifikasi adzan (sama dengan kolom `push_subscriptions.preferences`)
 * dan perhitungan kejadian pengingat yang dipakai bersama oleh server (cron push)
 * dan klien (pengingat lokal saat App terbuka).
 *
 * Satu notifikasi per waktu salat: notifikasi adzan sudah memuat jam iqamah, jadi tidak ada lagi
 * pengingat iqamah terpisah (dulu iqamah 10 menit sebelum iqamah = tepat pada menit adzan untuk
 * offset 10 menit, sehingga dua notifikasi muncul beruntun).
 */
export type PushPreferences = Record<ObligatoryPrayer, boolean> & {
  /** Usang (tidak dipakai lagi); tetap ada agar data lama di localStorage/DB tetap valid. */
  iqamahReminder: boolean;
  jumuah: boolean;
};

export const DEFAULT_PUSH_PREFS: PushPreferences = {
  fajr: true,
  dhuhr: true,
  asr: true,
  maghrib: true,
  isha: true,
  iqamahReminder: false,
  jumuah: true,
};

/** Kunci localStorage preferensi (PRD-07b). */
export const PUSH_PREFS_KEY = "acc-push-prefs";

/** Normalisasi nilai mentah (DB / localStorage) menjadi preferensi lengkap. */
export function normalizePreferences(raw: unknown): PushPreferences {
  const out: PushPreferences = { ...DEFAULT_PUSH_PREFS };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_PUSH_PREFS) as (keyof PushPreferences)[]) {
      if (typeof r[key] === "boolean") out[key] = r[key] as boolean;
    }
  }
  return out;
}

export type ReminderKind = "adhan" | "jumuah";

export type ReminderEvent = {
  kind: ReminderKind;
  prayer: ObligatoryPrayer;
  /** Kunci tanggal Tokyo YYYY-MM-DD. */
  dateKey: string;
  /** Waktu kejadian sebenarnya (adzan atau mulai Jumatan). */
  time: Date;
  /** Jam iqamah di masjid (khusus adzan), ditampilkan di isi notifikasi. */
  iqamah?: Date;
};

/** Menit sebelum Jumatan untuk pengingat Jumat. */
export const JUMUAH_LEAD_MIN = 30;

/** Tag notifikasi yang sama di server & klien agar notifikasi ganda saling menggantikan. */
export function reminderTag(e: Pick<ReminderEvent, "kind" | "prayer" | "dateKey">): string {
  return `${e.kind}-${e.prayer}-${e.dateKey}`;
}

/** Waktu ideal menampilkan pengingat di perangkat. */
export function reminderNotifyAt(e: Pick<ReminderEvent, "kind" | "time">): Date {
  const lead = e.kind === "jumuah" ? JUMUAH_LEAD_MIN : 0;
  return new Date(e.time.getTime() - lead * 60_000);
}

/**
 * Semua kejadian pengingat (sesuai preferensi) pada hari Tokyo `from` sampai `days` hari ke depan.
 * Pada hari Jumat, Zuhur digantikan Jumatan bila `config.jumuah.time` diisi.
 */
export function getReminderEvents(config: PrayerConfig, coords: GeoPoint, prefs: PushPreferences, from: Date = new Date(), days = 2): ReminderEvent[] {
  const out: ReminderEvent[] = [];
  for (let i = 0; i < days; i++) {
    const day = getPrayerTimesToday(config, coords, addDays(from, i));
    for (const prayer of OBLIGATORY_PRAYERS) {
      const isJumuah = day.isFriday && prayer === "dhuhr" && Boolean(config.jumuah.time);
      if (isJumuah) {
        if (prefs.jumuah) out.push({ kind: "jumuah", prayer, dateKey: day.dateKey, time: parseTokyoDate(day.dateKey, config.jumuah.time) });
        continue;
      }
      if (!prefs[prayer]) continue;
      out.push({ kind: "adhan", prayer, dateKey: day.dateKey, time: day.times[prayer], iqamah: day.iqamah[prayer] });
    }
  }
  return out.sort((a, b) => a.time.getTime() - b.time.getTime());
}

/** Pengingat berikutnya untuk perangkat (setelah `now`), berdasarkan waktu tampil idealnya. */
export function getNextLocalReminder(config: PrayerConfig, coords: GeoPoint, prefs: PushPreferences, now: Date = new Date()): { event: ReminderEvent; notifyAt: Date } | null {
  const events = getReminderEvents(config, coords, prefs, now, 2)
    .map((event) => ({ event, notifyAt: reminderNotifyAt(event) }))
    .filter((e) => e.notifyAt.getTime() > now.getTime())
    .sort((a, b) => a.notifyAt.getTime() - b.notifyAt.getTime());
  return events[0] ?? null;
}

/**
 * Interval pemicu cron server dalam menit. Bawaan 1: cron-job.org memanggil /api/push/send
 * tiap menit sehingga notifikasi adzan tiba tepat pada menit adzan (waktu salat dibulatkan
 * ke menit oleh pustaka adhan). Nilai lebih besar (mis. 5) tetap aman: kejadian dikirim
 * paling awal `interval` menit sebelum waktunya, tidak pernah terlambat atau terlewat.
 */
export const CRON_INTERVAL_MIN = 1;

/** Awal menit (ms) dari sebuah waktu. */
export function minuteFloor(d: Date): number {
  return Math.floor(d.getTime() / 60_000) * 60_000;
}

/**
 * Kejadian untuk dikirim cron pada `now`: waktu tampil idealnya (`reminderNotifyAt`: adzan tepat
 * waktu, Jumat 30 menit sebelumnya) berada di jendela
 * [awal menit `now`, + interval). Jendela berurutan tidak saling tumpang tindih sehingga tiap
 * kejadian dikirim tepat sekali bila cron berjalan tiap `intervalMin` menit.
 */
export function getCronEvents(config: PrayerConfig, coords: GeoPoint, now: Date = new Date(), intervalMin = CRON_INTERVAL_MIN): ReminderEvent[] {
  const start = minuteFloor(now);
  const end = start + Math.max(1, intervalMin) * 60_000;
  // Semua jenis kejadian; filter preferensi dilakukan per langganan.
  const all = getReminderEvents(config, coords, { ...DEFAULT_PUSH_PREFS }, addDays(now, -1), 3);
  return all.filter((e) => {
    const t = reminderNotifyAt(e).getTime();
    return t >= start && t < end;
  });
}

/**
 * Batas keterlambatan pengingat lokal: lebih dari ini dianggap terlewat (tab tertidur / perangkat
 * sleep) dan TIDAK dibunyikan, karena notifikasinya sudah ditangani push server atau sudah lewat.
 */
export const LOCAL_MAX_LATE_MS = 90_000;

/**
 * Pengingat yang jatuh tempo pada `now`: waktu tampil di (now - maxLate, now] dan tidak sebelum
 * `since` (saat App/halaman mulai terbuka). Dengan `since`, membuka App sesudah waktu adzan tidak
 * pernah memutar adzan "tiba-tiba"; hanya App yang SUDAH terbuka saat waktunya tiba yang berbunyi.
 */
export function getDueReminders(
  config: PrayerConfig,
  coords: GeoPoint,
  prefs: PushPreferences,
  now: Date = new Date(),
  { maxLateMs = LOCAL_MAX_LATE_MS, since }: { maxLateMs?: number; since?: number } = {},
): ReminderEvent[] {
  const n = now.getTime();
  return getReminderEvents(config, coords, prefs, addDays(now, -1), 3).filter((e) => {
    const t = reminderNotifyAt(e).getTime();
    if (since !== undefined && t < since) return false;
    return t <= n && n - t < maxLateMs;
  });
}

/** Apakah langganan dengan preferensi ini ingin menerima kejadian tersebut. */
export function wantsEvent(prefs: PushPreferences, e: Pick<ReminderEvent, "kind" | "prayer">): boolean {
  if (e.kind === "jumuah") return prefs.jumuah;
  return prefs[e.prayer];
}

export type ReminderTranslate = (key: "adhanTitle" | "adhanBody" | "jumuahTitle" | "jumuahBody", values: Record<string, string | number>) => string;

/** Judul & isi notifikasi pengingat (teks dari namespace `settings.notify`). Adzan memuat jam iqamah. */
export function buildReminderMessage(e: ReminderEvent, locale: Locale, t: ReminderTranslate, prayerName: (p: ObligatoryPrayer) => string): { title: string; body: string } {
  const values = {
    prayer: prayerName(e.prayer),
    time: formatTime(e.time, locale),
    iqamah: formatTime(e.iqamah ?? e.time, locale),
    minutes: JUMUAH_LEAD_MIN,
  };
  if (e.kind === "jumuah") return { title: t("jumuahTitle", values), body: t("jumuahBody", values) };
  return { title: t("adhanTitle", values), body: t("adhanBody", values) };
}

export { SW_REMINDER_MESSAGE, type ReminderPushPayload, type SwReminderMessage } from "./reminder-message";
