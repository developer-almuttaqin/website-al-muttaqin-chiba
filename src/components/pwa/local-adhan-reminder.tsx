"use client";

import * as React from "react";
import { Volume2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { GeoPoint, Locale, PrayerConfig } from "@/lib/types";
import { getSwRegistration, useIsClient, useNotificationPermission } from "./browser-state";
import { useLocalJson } from "./local-store";
import { claimReminder } from "./fired-store";
import {
  ADHAN_VIBRATE,
  REMINDER_VIBRATE,
  dismissAlertForTag,
  installAudioUnlock,
  readSoundSettings,
  triggerAlert,
  unlockAudio,
  useAdhanAlert,
  useAudioUnlocked,
  useSoundSettings,
  warmAlertSounds,
  type AlertKind,
} from "./adhan-sound";
import { AdhanAlertBanner } from "./adhan-alert-banner";
import {
  NOTIFY_BADGE,
  NOTIFY_ICON,
  SW_REMINDER_MESSAGE,
  SW_REMINDER_STOP,
  isPrayerKind,
  payloadNotifyTime,
  type SwReminderMessage,
  type SwReminderReply,
  type SwReminderStopMessage,
} from "./reminder-message";
import { PUSH_PREFS_KEY, buildReminderMessage, getDueReminders, getNextLocalReminder, reminderTag, type ReminderEvent, type ReminderTranslate } from "./reminders";
import { DEFAULT_STORED_PUSH, toStoredSettings, type StoredPushSettings } from "./use-push-subscription";

/** Pengecekan berkala terhadap jam (tahan terhadap timer yang ditunda saat tab di latar belakang). */
const CHECK_INTERVAL_MS = 15_000;

/**
 * Jeda antar-pengecekan yang lebih besar dari ini berarti JS App sempat dibekukan (PWA di latar
 * belakang, ponsel tidur). Di atas penundaan timer tab tersembunyi Chrome (maks. 1 menit).
 */
const SUSPEND_GAP_MS = 75_000;

/** Pesan dari SW yang tertahan lebih lama dari ini (App dilanjutkan dari latar belakang) tidak dibunyikan. */
const SW_MESSAGE_MAX_AGE_MS = 60_000;

function alertKind(kind: SwReminderMessage["payload"]["kind"]): AlertKind {
  return kind ?? "broadcast";
}

/** Tutup notifikasi waktu salat lain agar paling banyak satu yang tampil. */
async function closeOtherPrayerNotifications(reg: ServiceWorkerRegistration, keepTag: string): Promise<void> {
  try {
    const list = await reg.getNotifications();
    for (const n of list) {
      const kind = (n.data as { kind?: SwReminderMessage["payload"]["kind"] } | null)?.kind;
      if (n.tag !== keepTag && isPrayerKind(kind)) n.close();
    }
  } catch {
    // abaikan
  }
}

/**
 * Pengingat lokal saat App terbuka (tanpa server), dipasang sekali di layout App:
 * - tiap 15 detik (dan saat App aktif lagi / fokus / online) mencari pengingat yang jatuh tempo
 *   (adzan dengan jam iqamah, Jumat 30 menit sebelumnya); bila pengingat berikutnya kurang dari
 *   satu interval lagi, timer presisi dipasang tepat pada detiknya,
 * - hanya kejadian yang terjadi SELAMA App terbuka dan berjalan (paling lambat 90 detik lalu) yang
 *   dibunyikan; membuka App, kembali ke /app, atau melanjutkan App dari latar belakang tidak pernah
 *   memutar adzan yang waktunya sudah lewat,
 * - tiap kejadian diklaim di catatan bersama SW & halaman (`fired-store`): bila push server sudah
 *   menanganinya (atau tab lain), tidak berbunyi lagi -> satu kejadian, satu notifikasi,
 * - App terlihat dan suara berbunyi: banner + suara khas (adzan / jingle) tanpa notifikasi sistem
 *   tambahan; suara diblokir (App belum diketuk) atau App tidak terlihat: notifikasi sistem juga,
 * - pesan dari service worker saat push server tiba ketika App terlihat (memutar suara khas),
 *   dan saat notifikasinya ditutup (menghentikan suara).
 */
export function useLocalAdhanReminder({ config, coordinates }: { config: PrayerConfig; coordinates: GeoPoint }) {
  const locale = useLocale() as Locale;
  const t = useTranslations("settings");
  const tp = useTranslations("prayer");
  const permission = useNotificationPermission();
  const [raw] = useLocalJson<StoredPushSettings>(PUSH_PREFS_KEY, DEFAULT_STORED_PUSH);
  const settings = React.useMemo(() => toStoredSettings(raw), [raw]);
  const [sound] = useSoundSettings();
  /**
   * Batas bawah waktu kejadian yang boleh berbunyi: saat App terakhir "dibuka" (host dipasang,
   * kembali ke /app dari halaman situs, pengingat diaktifkan, atau App dilanjutkan dari latar
   * belakang). Kejadian sebelum ini tidak pernah dibunyikan, jadi membuka App, termasuk lewat
   * notifikasi adzan, hanya membuka App, bukan memutar adzan tiba-tiba.
   */
  const sinceRef = React.useRef(0);

  const fire = React.useEffectEvent(async (event: ReminderEvent) => {
    const tag = reminderTag(event);
    if (!(await claimReminder(tag, "local"))) return;
    const translate: ReminderTranslate = (key, values) => t(`notify.${key}`, values);
    const { title, body } = buildReminderMessage(event, locale, translate, (p) => tp(`names.${p}`));
    const soundSettings = readSoundSettings();
    const url = `/${locale}/app/prayer`;
    const visible = document.visibilityState === "visible";
    const outcome = await triggerAlert({ title, body, tag, kind: event.kind, url }, soundSettings);
    // App sedang dilihat dan pengingatnya sudah berbunyi (atau pengguna memilih senyap/getar):
    // banner + suara sudah menjadi notifikasinya, tanpa notifikasi sistem dobel.
    const handled = outcome !== "blocked";
    if ((visible && handled) || permission !== "granted") return;
    // Suara diblokir (App belum diketuk) atau App tidak terlihat: notifikasi sistem. Senyap bila
    // App sendiri sudah berbunyi, agar tidak terdengar dua suara sekaligus.
    const quiet = soundSettings.mode === "silent" || outcome === "played";
    try {
      const options: NotificationOptions & { renotify?: boolean; vibrate?: number[]; actions?: { action: string; title: string }[] } = {
        body,
        tag,
        renotify: !quiet,
        requireInteraction: event.kind === "adhan",
        silent: quiet,
        vibrate: quiet ? undefined : event.kind === "adhan" ? ADHAN_VIBRATE : REMINDER_VIBRATE,
        icon: NOTIFY_ICON,
        badge: NOTIFY_BADGE,
        data: { url, kind: event.kind, tag },
      };
      const reg = await getSwRegistration(3000);
      if (reg) {
        options.actions = [
          { action: "open", title: t("notify.actionOpen") },
          { action: "dismiss", title: t("notify.actionDismiss") },
        ];
        await closeOtherPrayerNotifications(reg, tag);
        await reg.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
    } catch {
      // Notifikasi sistem gagal: banner & suara di halaman tetap tampil.
    }
  });

  /**
   * Push server tiba saat App terlihat: bunyikan di App lalu jawab SW apakah sudah ditangani. Tidak
   * ditangani (pesan tertahan, kejadian sebelum App dibuka, suara diblokir) -> SW menampilkan
   * notifikasi sistem bersuara seperti biasa.
   */
  const onPush = React.useEffectEvent(async (message: SwReminderMessage): Promise<boolean> => {
    if (document.visibilityState !== "visible") return false;
    if (Date.now() - message.receivedAt > SW_MESSAGE_MAX_AGE_MS) return false;
    const { payload } = message;
    const notifyTime = payloadNotifyTime(payload);
    if (notifyTime !== null && isPrayerKind(payload.kind) && notifyTime < sinceRef.current) return false;
    const outcome = await triggerAlert({ title: payload.title, body: payload.body, tag: payload.tag, kind: alertKind(payload.kind), url: payload.url });
    return outcome !== "blocked";
  });

  // Pengecekan berkala terhadap jam.
  React.useEffect(() => {
    if (!settings.enabled) return;
    let precise: number | undefined;
    // Setiap pemasangan (buka App, kembali ke /app, aktifkan pengingat) dihitung sebagai "membuka App".
    sinceRef.current = Math.max(sinceRef.current, Date.now());
    let lastCheck = Date.now();
    const check = () => {
      const now = Date.now();
      // JS sempat dibekukan (PWA dilanjutkan dari latar belakang): kejadian selama beku sudah lewat,
      // jangan dibunyikan saat App dibuka lagi.
      if (now - lastCheck > SUSPEND_GAP_MS) sinceRef.current = Math.max(sinceRef.current, now);
      lastCheck = now;
      for (const event of getDueReminders(config, coordinates, settings, new Date(now), { since: sinceRef.current })) void fire(event);
    };
    const tick = () => {
      check();
      window.clearTimeout(precise);
      const next = getNextLocalReminder(config, coordinates, settings, new Date());
      if (!next) return;
      const delay = next.notifyAt.getTime() - Date.now();
      if (delay <= CHECK_INTERVAL_MS + 1000) precise = window.setTimeout(check, Math.max(0, delay) + 150);
    };
    tick();
    const interval = window.setInterval(tick, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    window.addEventListener("online", tick);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(precise);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
      window.removeEventListener("online", tick);
    };
  }, [config, coordinates, settings]);

  // Pesan service worker: push tiba saat App terlihat (putar suara) / notifikasi ditutup (hentikan).
  React.useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; payload?: unknown; receivedAt?: unknown; tag?: unknown } | null;
      if (data?.type === SW_REMINDER_MESSAGE && data.payload && typeof data.receivedAt === "number") {
        const port = e.ports[0];
        void onPush(data as SwReminderMessage)
          .catch(() => false)
          .then((handled) => {
            const reply: SwReminderReply = { handled };
            port?.postMessage(reply);
          });
      } else if (data?.type === SW_REMINDER_STOP && typeof data.tag === "string") {
        dismissAlertForTag((data as SwReminderStopMessage).tag);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // Buka kunci audio pada gestur yang sah (touchend / click / keydown), sepanjang sesi.
  React.useEffect(() => {
    installAudioUnlock();
  }, []);

  // Simpan suara pengingat di cache agar tetap berbunyi saat offline.
  React.useEffect(() => {
    if (!settings.enabled) return;
    const id = window.setTimeout(() => warmAlertSounds(sound.mode), 4000);
    return () => window.clearTimeout(id);
  }, [settings.enabled, sound.mode]);

  return { enabled: settings.enabled && permission !== "denied", soundMode: sound.mode };
}

/**
 * Petunjuk kecil di atas navigasi bawah: browser baru mengizinkan suara otomatis setelah App
 * diketuk sekali setiap kali dibuka. Hilang sendiri setelah ketukan pertama.
 */
function SoundUnlockHint() {
  const t = useTranslations("settings");
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.25rem+max(0.5rem,env(safe-area-inset-bottom))+0.75rem)] z-40 flex justify-center px-4">
      <button
        type="button"
        onClick={(e) => unlockAudio(e.currentTarget)}
        className="pointer-events-auto inline-flex animate-fade-up items-center gap-2 rounded-full bg-hero px-4 py-2 text-xs font-semibold text-hero-foreground shadow-soft ring-1 ring-hero-foreground/10"
      >
        <Volume2 className="size-4 shrink-0 stroke-[1.5]" aria-hidden />
        {t("alert.unlockHint")}
      </button>
    </div>
  );
}

/** Dipasang sekali di layout App: pengingat lokal + banner + petunjuk membuka suara. */
export function AdhanReminderHost({ config, coordinates }: { config: PrayerConfig; coordinates: GeoPoint }) {
  const { enabled, soundMode } = useLocalAdhanReminder({ config, coordinates });
  const isClient = useIsClient();
  const unlocked = useAudioUnlocked();
  const alert = useAdhanAlert();
  const audible = soundMode === "adhan" || soundMode === "chime";
  return (
    <>
      <AdhanAlertBanner />
      {isClient && enabled && audible && !unlocked && alert.status === "idle" && <SoundUnlockHint />}
    </>
  );
}
