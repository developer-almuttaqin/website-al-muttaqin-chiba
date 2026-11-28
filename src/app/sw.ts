import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, CacheableResponsePlugin, ExpirationPlugin, NetworkFirst, RangeRequestsPlugin, Serwist, StaleWhileRevalidate } from "serwist";
import { claimReminder } from "@/components/pwa/fired-store";
import {
  ADHAN_VIBRATE,
  APP_PATH,
  NOTIFY_BADGE,
  NOTIFY_ICON,
  REMINDER_FRESH_MS,
  REMINDER_VIBRATE,
  SW_NAVIGATE,
  SW_REMINDER_MESSAGE,
  SW_REMINDER_STOP,
  SW_REPLY_TIMEOUT_MS,
  isPrayerKind,
  payloadNotifyTime,
  type ReminderPushPayload,
  type SwNavigateMessage,
  type SwReminderMessage,
  type SwReminderReply,
  type SwReminderStopMessage,
} from "@/components/pwa/reminder-message";

/**
 * Service worker App Jamaah (PRD-07 / §7 Offline):
 * - precache halaman inti App & fallback offline untuk ketiga bahasa,
 * - cache runtime untuk API Al-Qur'an, jadwal salat, dan halaman (network-first),
 * - notifikasi push adzan (payload dari /api/push/send): satu notifikasi per waktu salat,
 *   suara khas di App bila sedang terlihat, dan klik notifikasi hanya membuka/mengarahkan App.
 */
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const LOCALES = ["ja", "en", "id"] as const;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Teks Al-Qur'an & terjemahan: jarang berubah, simpan lama.
      matcher: ({ url }) => url.hostname === "api.alquran.cloud" || url.hostname === "api.quran.com",
      handler: new CacheFirst({
        cacheName: "quran-api",
        plugins: [new ExpirationPlugin({ maxEntries: 400, maxAgeSeconds: 180 * 24 * 60 * 60 })],
      }),
    },
    {
      // Jadwal salat & data publik aplikasi: tampilkan cache, perbarui di belakang.
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/prayer"),
      handler: new StaleWhileRevalidate({
        cacheName: "prayer-api",
        plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 7 * 24 * 60 * 60 })],
      }),
    },
    {
      // Suara adzan (public/audio): simpan setelah diputar sekali agar tetap berbunyi saat offline.
      // RangeRequestsPlugin melayani permintaan Range dari elemen <audio> (Safari) dari cache.
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/audio/"),
      handler: new CacheFirst({
        cacheName: "adhan-audio",
        plugins: [new CacheableResponsePlugin({ statuses: [200] }), new RangeRequestsPlugin(), new ExpirationPlugin({ maxEntries: 6, maxAgeSeconds: 365 * 24 * 60 * 60 })],
      }),
    },
    {
      // Thumbnail YouTube
      matcher: ({ url }) => url.hostname === "i.ytimg.com",
      handler: new CacheFirst({
        cacheName: "youtube-thumbs",
        plugins: [new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
    {
      // Ubin peta OpenStreetMap
      matcher: ({ url }) => url.hostname.endsWith("tile.openstreetmap.org"),
      handler: new CacheFirst({
        cacheName: "osm-tiles",
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 14 * 24 * 60 * 60 })],
      }),
    },
    {
      // Halaman App Jamaah: network-first agar konten segar, tetap terbuka saat offline.
      matcher: ({ request, url, sameOrigin }) => sameOrigin && request.destination === "document" && /^\/(ja|en|id)\/app(\/|$)/.test(url.pathname),
      handler: new NetworkFirst({
        cacheName: "app-pages",
        networkTimeoutSeconds: 4,
        plugins: [new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: LOCALES.map((locale) => ({
      url: `/${locale}/offline`,
      matcher({ request }) {
        return request.destination === "document" && new URL(request.url).pathname.startsWith(`/${locale}/`);
      },
    })),
  },
});

// Streaming media lintas domain (murottal cdn.islamic.network / mp3quran.net, video) tidak
// boleh lewat service worker: aturan "cross-origin" bawaan (NetworkFirst) mencoba menyimpan
// berkas puluhan MB dan permintaan Range, sehingga pemutaran di PWA iOS gagal. Didaftarkan
// sebelum pendengar Serwist; tanpa respondWith, browser mengambilnya langsung dari jaringan.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const crossOrigin = new URL(request.url).origin !== self.location.origin;
  const media = request.destination === "audio" || request.destination === "video" || request.headers.has("range");
  if (crossOrigin && media) event.stopImmediatePropagation();
});

serwist.addEventListeners();

// ---------------------------------------------------------------
// Notifikasi push pengingat (Web Push VAPID). Payload JSON: ReminderPushPayload
// { title, body, url, tag, kind?, prayer?, at?, actions? }.
//
// - Setiap tag diklaim di catatan bersama SW & halaman (fired-store): bila pengingat lokal App
//   (atau push ganda dari penjadwal) sudah menanganinya, notifikasi hanya diganti diam-diam,
//   tidak berbunyi/bergetar lagi -> satu kejadian, satu notifikasi.
// - Paling banyak SATU notifikasi waktu salat tampil: yang lama ditutup saat yang baru datang.
// - Halaman App (/[locale]/app) sedang terlihat: SW meminta halaman memutar suara khas (adzan /
//   jingle) dan menampilkan banner, lalu MENUNGGU jawabannya. Hanya bila halaman menjawab "sudah
//   ditangani" (suara berbunyi / pengguna memilih senyap), notifikasi sistem dibuat senyap (Safari
//   wajib menampilkan notifikasi untuk setiap push) atau dilewati (Chromium/Firefox). Bila suara
//   diblokir (App belum diketuk), tidak ada jawaban, atau yang terlihat halaman situs biasa, notifikasi
//   sistem tampil bersuara seperti biasa.
// - Browser tidak mengizinkan suara kustom untuk notifikasi saat App tertutup; perangkat memakai
//   suara notifikasi standarnya.
// ---------------------------------------------------------------

function parsePayload(data: PushMessageData): ReminderPushPayload {
  try {
    const raw = data.json() as Partial<ReminderPushPayload>;
    return {
      title: raw.title ?? "Al Muttaqin",
      body: raw.body ?? "",
      url: raw.url ?? "/id/app",
      tag: raw.tag ?? `acc-${Date.now()}`,
      kind: raw.kind,
      prayer: raw.prayer,
      at: raw.at,
      notifyAt: raw.notifyAt,
      actions: raw.actions,
    };
  } catch {
    return { title: "Al Muttaqin", body: data.text(), url: "/id/app", tag: `acc-${Date.now()}`, kind: "broadcast" };
  }
}

/** Safari (iOS/iPadOS/macOS): setiap push wajib menampilkan notifikasi, walau App sedang terbuka. */
function requiresVisibleNotification(): boolean {
  const ua = self.navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Android|Edg|Firefox|FxiOS/.test(ua);
}

/** Tutup notifikasi waktu salat lain agar paling banyak satu yang tampil. */
async function closeOtherPrayerNotifications(keepTag: string): Promise<void> {
  const list = await self.registration.getNotifications().catch(() => [] as Notification[]);
  for (const n of list) {
    const kind = (n.data as { kind?: ReminderPushPayload["kind"] } | null)?.kind;
    if (n.tag !== keepTag && isPrayerKind(kind)) n.close();
  }
}

async function showReminder(payload: ReminderPushPayload, quiet: boolean): Promise<void> {
  const isAdhan = payload.kind === "adhan";
  const prayer = isPrayerKind(payload.kind);
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[]; actions?: { action: string; title: string }[]; timestamp?: number } = {
    body: payload.body,
    icon: NOTIFY_ICON,
    badge: NOTIFY_BADGE,
    tag: payload.tag,
    lang: payload.url.match(/^\/(ja|en|id)(\/|$)/)?.[1],
    // renotify & silent tidak boleh sama-sama true (TypeError).
    renotify: !quiet,
    silent: quiet,
    requireInteraction: isAdhan && !quiet,
    vibrate: quiet ? undefined : isAdhan ? ADHAN_VIBRATE : prayer ? REMINDER_VIBRATE : undefined,
    timestamp: payload.at ? Date.parse(payload.at) : Date.now(),
    data: { url: payload.url, kind: payload.kind, tag: payload.tag },
  };
  if (payload.actions) {
    options.actions = [
      { action: "open", title: payload.actions.open },
      { action: "dismiss", title: payload.actions.dismiss },
    ];
  }
  if (prayer) await closeOtherPrayerNotifications(payload.tag);
  await self.registration.showNotification(payload.title, options);
}

async function windowClients(): Promise<WindowClient[]> {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return list.filter((c) => new URL(c.url).origin === self.location.origin);
}

function isAppWindow(c: WindowClient): boolean {
  return APP_PATH.test(new URL(c.url).pathname);
}

/** Minta halaman App membunyikan pengingat; true hanya bila halaman menjawab sudah menanganinya. */
function askApp(client: WindowClient, message: SwReminderMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), SW_REPLY_TIMEOUT_MS);
    channel.port1.onmessage = (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(Boolean((e.data as Partial<SwReminderReply> | null)?.handled));
    };
    try {
      client.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function handlePush(payload: ReminderPushPayload): Promise<void> {
  const receivedAt = Date.now();
  const first = await claimReminder(payload.tag, "push");
  const windows = await windowClients();
  // Hanya layar App yang memasang pendengar pengingat; halaman situs/admin tidak dihitung.
  const visibleApps = windows.filter((c) => c.visibilityState === "visible" && isAppWindow(c));
  const target = visibleApps.find((c) => c.focused) ?? visibleApps[0];
  // Hanya kejadian yang baru saja terjadi yang dibunyikan di App (bukan push yang tertunda lama).
  const notifyTime = payloadNotifyTime(payload) ?? receivedAt;
  const fresh = receivedAt - notifyTime < REMINDER_FRESH_MS;
  let handledInApp = false;
  if (first && target && fresh) {
    handledInApp = await askApp(target, { type: SW_REMINDER_MESSAGE, payload, receivedAt });
  }
  const webkit = requiresVisibleNotification();
  // Sudah berbunyi di App yang terlihat: Chromium/Firefox tidak butuh notifikasi sistem.
  if (handledInApp && !webkit) return;
  // Kejadian ini sudah ditangani sebelumnya (pengingat lokal / push ganda) dan App sedang terlihat:
  // jangan menambah salinan senyap di baki notifikasi.
  if (!first && target && !webkit) return;
  await showReminder(payload, !first || handledInApp);
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const payload = parsePayload(event.data);
  event.waitUntil(handlePush(payload).catch(() => showReminder(payload, false)));
});

async function broadcastStop(tag: string | undefined): Promise<void> {
  if (!tag) return;
  const message: SwReminderStopMessage = { type: SW_REMINDER_STOP, tag };
  for (const client of await windowClients()) client.postMessage(message);
}

/**
 * Klik notifikasi: cukup buka / arahkan App ke halaman tujuan. Pilih jendela yang sedang dipakai,
 * lalu jendela App mana pun; bila tidak ada, buka jendela baru (di Android diarahkan ke App
 * terpasang). Tidak memutar suara apa pun: App yang baru dibuka tidak membunyikan kejadian lampau.
 */
async function openApp(url: string): Promise<void> {
  const target = new URL(url, self.location.origin);
  const windows = await windowClients();
  const client = windows.find((c) => c.focused) ?? windows.find((c) => c.visibilityState === "visible") ?? windows.find(isAppWindow);
  if (!client) {
    await self.clients.openWindow(target.href);
    return;
  }
  const focused = await client.focus().catch(() => client);
  const current = new URL(focused.url);
  if (current.pathname === target.pathname && current.search === target.search) return;
  const message: SwNavigateMessage = { type: SW_NAVIGATE, url: target.pathname + target.search + target.hash };
  // Sudah di dalam App: pindah lewat router halaman (navigasi lunak) agar adzan yang sedang
  // berbunyi beserta bannernya tidak terputus oleh muat ulang dokumen.
  if (APP_PATH.test(current.pathname) && APP_PATH.test(target.pathname)) {
    focused.postMessage(message);
    return;
  }
  const navigated = await focused.navigate(target.href).catch(() => null);
  // Jendela belum dikendalikan SW (navigate ditolak): minta halaman pindah sendiri.
  if (!navigated) focused.postMessage(message);
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  notification.close();
  const data = notification.data as { url?: string; tag?: string } | undefined;
  if (event.action === "dismiss") {
    event.waitUntil(broadcastStop(data?.tag ?? notification.tag));
    return;
  }
  event.waitUntil(openApp(data?.url ?? "/id/app"));
});

self.addEventListener("notificationclose", (event) => {
  const data = event.notification.data as { tag?: string } | undefined;
  event.waitUntil(broadcastStop(data?.tag ?? event.notification.tag));
});

/**
 * Browser mengganti / mencabut langganan push (Chromium & Firefox; Safari tidak memicunya):
 * buat ulang dengan kunci server yang sama lalu daftarkan ke server, agar adzan tetap datang
 * walau App tidak dibuka. Bahasa & preferensi dipindahkan server dari baris lama (`oldEndpoint`).
 * Bila gagal, App mendaftarkan ulang sendiri saat dibuka berikutnya (syncPushSubscription).
 */
async function renewSubscription(event: PushSubscriptionChangeEvent): Promise<void> {
  const old = event.oldSubscription;
  const key = old?.options.applicationServerKey ?? null;
  const sub = event.newSubscription ?? (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
  if (!sub) return;
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: old?.endpoint }),
  });
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(renewSubscription(event).catch(() => undefined));
});
