"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import { getSwRegistration, notifyPermissionChange, useNotificationPermission, usePushSupported, type PermissionState } from "./browser-state";
import { readLocalJson, useLocalJson, writeLocal } from "./local-store";
import { DEFAULT_PUSH_PREFS, PUSH_PREFS_KEY, normalizePreferences, type PushPreferences } from "./reminders";
import { ADHAN_VIBRATE, NOTIFY_BADGE, NOTIFY_ICON } from "./reminder-message";

/** Isi `acc-push-prefs`: preferensi per salat + sakelar utama `enabled`. */
export type StoredPushSettings = PushPreferences & { enabled: boolean };
export const DEFAULT_STORED_PUSH: StoredPushSettings = { ...DEFAULT_PUSH_PREFS, enabled: false };

export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export type EnableResult = "granted" | "denied" | "unsupported" | "error";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function postSubscription(sub: PushSubscription, locale: string, preferences: PushPreferences, oldEndpoint?: string): Promise<boolean> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), locale, preferences, oldEndpoint }),
  });
  return res.ok;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** true bila langganan dibuat dengan kunci VAPID `key` (browser tanpa info kunci dianggap sama). */
function sameServerKey(sub: PushSubscription, key: Uint8Array): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/**
 * Langganan push dengan kunci VAPID saat ini. Langganan lama yang dibuat dengan kunci lain
 * (kunci server diganti) dilepas lalu dibuat ulang, karena push server tidak akan pernah sampai.
 */
async function ensureSubscription(reg: ServiceWorkerRegistration): Promise<{ sub: PushSubscription; oldEndpoint?: string }> {
  const key = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  const existing = await reg.pushManager.getSubscription();
  if (existing && sameServerKey(existing, key)) return { sub: existing };
  const oldEndpoint = existing?.endpoint;
  if (existing) await existing.unsubscribe().catch(() => false);
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return { sub, oldEndpoint };
}

/** Catatan sinkron terakhir: endpoint + waktu, agar App tidak mengirim ulang di setiap halaman. */
const SYNC_KEY = "acc-push-sync";
const SYNC_EVERY_MS = 60 * 60_000;
/** Dipancarkan setelah sinkron agar status "Push aktif" di Pengaturan ikut diperbarui. */
const SYNC_EVENT = "acc-push-synced";

let syncing: Promise<void> | null = null;

/**
 * Jaga agar perangkat yang SUDAH mengaktifkan notifikasi selalu berlangganan push server, tanpa
 * perlu menekan tombol lagi: dipanggil setiap App/situs dibuka. Menangani kunci VAPID yang baru
 * dipasang (pengguna mengaktifkan notifikasi saat server belum siap), langganan yang diganti
 * browser, dan baris yang terhapus di server. Diam saja bila izin belum diberikan.
 */
export function syncPushSubscription(locale: string, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    if (VAPID_PUBLIC_KEY.length === 0 || typeof window === "undefined") return;
    if (!("Notification" in window) || !("PushManager" in window) || Notification.permission !== "granted") return;
    const stored = toStoredSettings(readLocalJson<unknown>(PUSH_PREFS_KEY, null));
    if (!stored.enabled) return;
    const reg = await getSwRegistration(10_000);
    if (!reg) return;
    const { sub, oldEndpoint } = await ensureSubscription(reg);
    const last = readLocalJson<{ endpoint?: string; at?: number; locale?: string } | null>(SYNC_KEY, null);
    const recent = last?.endpoint === sub.endpoint && last.locale === locale && typeof last.at === "number" && Date.now() - last.at < SYNC_EVERY_MS;
    if (!force && !oldEndpoint && recent) return;
    const ok = await postSubscription(sub, locale, normalizePreferences(stored), oldEndpoint);
    if (ok) writeLocal(SYNC_KEY, JSON.stringify({ endpoint: sub.endpoint, at: Date.now(), locale }));
    window.dispatchEvent(new Event(SYNC_EVENT));
  })()
    .catch(() => undefined)
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

export type ServerTestResult = { ok: true; delaySec: number } | { ok: false; reason: string };

/** Baca pengaturan push dari nilai mentah localStorage. */
export function toStoredSettings(raw: unknown): StoredPushSettings {
  const enabled = Boolean(raw && typeof raw === "object" && (raw as { enabled?: unknown }).enabled === true);
  return { ...normalizePreferences(raw), enabled };
}

/**
 * Langganan Web Push (PRD-07b): izin diminta setelah klik, `PushManager.subscribe` dengan
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY, lalu POST /api/push/subscribe { subscription, locale, preferences }.
 * Tanpa VAPID key: hanya izin notifikasi (pengingat lokal tetap bekerja saat App terbuka).
 */
export function usePushSubscription() {
  const locale = useLocale();
  const supported = usePushSupported();
  const permission: PermissionState = useNotificationPermission();
  const [rawStored, setStored] = useLocalJson<StoredPushSettings>(PUSH_PREFS_KEY, DEFAULT_STORED_PUSH);
  const settings = React.useMemo(() => toStoredSettings(rawStored), [rawStored]);
  const [endpoint, setEndpoint] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const vapidConfigured = VAPID_PUBLIC_KEY.length > 0;

  React.useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const refresh = () => {
      currentSubscription()
        .then((sub) => {
          if (!cancelled) setEndpoint(sub?.endpoint ?? null);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener(SYNC_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(SYNC_EVENT, refresh);
    };
  }, [supported]);

  const enable = React.useCallback(async (): Promise<EnableResult> => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      notifyPermissionChange();
      if (result !== "granted") return "denied";
      const prefs = normalizePreferences(settings);
      setStored({ ...prefs, enabled: true });
      if (vapidConfigured && supported) {
        const reg = await getSwRegistration(10_000);
        if (!reg) return "error";
        const { sub, oldEndpoint } = await ensureSubscription(reg);
        setEndpoint(sub.endpoint);
        if (await postSubscription(sub, locale, prefs, oldEndpoint)) writeLocal(SYNC_KEY, JSON.stringify({ endpoint: sub.endpoint, at: Date.now(), locale }));
      }
      return "granted";
    } catch {
      return "error";
    } finally {
      setBusy(false);
    }
  }, [settings, setStored, vapidConfigured, supported, locale]);

  const disable = React.useCallback(async () => {
    setBusy(true);
    try {
      setStored({ ...normalizePreferences(settings), enabled: false });
      writeLocal(SYNC_KEY, null);
      const sub = await currentSubscription();
      if (sub) {
        const { endpoint: ep } = sub;
        await sub.unsubscribe().catch(() => false);
        await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: ep }) }).catch(() => undefined);
      }
      setEndpoint(null);
    } finally {
      setBusy(false);
    }
  }, [settings, setStored]);

  const setPreference = React.useCallback(
    (key: keyof PushPreferences, value: boolean) => {
      const prefs = { ...normalizePreferences(settings), [key]: value };
      setStored({ ...prefs, enabled: settings.enabled });
      if (endpoint && vapidConfigured) {
        currentSubscription()
          .then((sub) => (sub ? postSubscription(sub, locale, prefs) : false))
          .catch(() => false);
      }
    },
    [settings, setStored, endpoint, vapidConfigured, locale],
  );

  /**
   * Notifikasi uji lewat registration.showNotification (fallback: Notification biasa).
   * `silent`: App sedang memutar suara khasnya sendiri, jadi notifikasi sistem tidak ikut berbunyi.
   */
  const sendTest = React.useCallback(async (title: string, body: string, { silent = false }: { silent?: boolean } = {}): Promise<boolean> => {
    if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return false;
    const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
      body,
      icon: NOTIFY_ICON,
      badge: NOTIFY_BADGE,
      tag: "acc-test",
      renotify: !silent,
      silent,
      vibrate: silent ? undefined : ADHAN_VIBRATE,
      data: { url: `/${locale}/app/settings`, kind: "test", tag: "acc-test" },
    };
    try {
      const reg = await getSwRegistration(3000);
      if (reg) await reg.showNotification(title, options);
      else new Notification(title, options);
      return true;
    } catch {
      return false;
    }
  }, [locale]);

  /**
   * Uji jalur server yang sama dengan adzan saat App tertutup: server mengirim Web Push ke
   * perangkat ini setelah `delaySec` detik, sehingga pengguna sempat menutup App / mengunci layar.
   */
  const sendServerTest = React.useCallback(
    async (delaySec: number): Promise<ServerTestResult> => {
      try {
        await syncPushSubscription(locale, { force: true });
        const sub = await currentSubscription();
        setEndpoint(sub?.endpoint ?? null);
        if (!sub) return { ok: false, reason: "not-subscribed" };
        const res = await fetch("/api/push/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint, delay: delaySec }),
        });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string };
        if (res.ok && json.ok) return { ok: true, delaySec };
        return { ok: false, reason: json.reason ?? json.error ?? `http-${res.status}` };
      } catch {
        return { ok: false, reason: "network" };
      }
    },
    [locale],
  );

  return {
    supported,
    permission,
    vapidConfigured,
    enabled: settings.enabled && permission === "granted",
    subscribed: Boolean(endpoint),
    preferences: normalizePreferences(settings),
    busy,
    enable,
    disable,
    setPreference,
    sendTest,
    sendServerTest,
  };
}
