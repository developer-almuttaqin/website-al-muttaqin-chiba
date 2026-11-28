"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { Locale } from "@/lib/types";
import { startInstallListener } from "./install-store";
import { OfflineBadge } from "./offline-badge";
import { SW_NAVIGATE, type SwNavigateMessage } from "./reminder-message";

/** Sinkron langganan push hanya bila izin sudah diberikan; modulnya dimuat belakangan agar situs tetap ringan. */
function syncPush(locale: string): void {
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  void import("./use-push-subscription").then((m) => m.syncPushSubscription(locale)).catch(() => undefined);
}

/** Penanda per sesi peluncuran PWA (sessionStorage hilang saat App ditutup penuh). */
const LAUNCH_KEY = "acc-launch-checked";

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

/**
 * Dipasang sekali di layout locale:
 * - menangkap `beforeinstallprompt` sejak awal,
 * - PWA terpasang yang dibuka di beranda situs (mis. iOS lama memakai URL halaman saat
 *   "Tambah ke Layar Utama", bukan start_url) langsung diarahkan ke App Jamaah, sekali per peluncuran,
 * - menjalankan permintaan pindah halaman dari service worker (klik notifikasi saat jendela belum
 *   dikendalikan SW),
 * - menjaga langganan push server tetap hidup (setiap dibuka & kembali ke layar) agar notifikasi
 *   adzan tetap datang saat App tertutup,
 * - menampilkan pil offline global (beranda App punya indikator sendiri).
 */
export function PwaRuntime() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();

  React.useEffect(() => {
    startInstallListener();
  }, []);

  React.useEffect(() => {
    syncPush(locale);
    const onVisible = () => {
      if (document.visibilityState === "visible") syncPush(locale);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [locale]);

  const onLaunch = React.useEffectEvent(() => {
    try {
      if (window.sessionStorage.getItem(LAUNCH_KEY)) return;
      window.sessionStorage.setItem(LAUNCH_KEY, "1");
    } catch {
      return;
    }
    if (isStandalone() && pathname === "/" && !window.location.hash) router.replace("/app");
  });

  React.useEffect(() => {
    onLaunch();
  }, []);

  /** Pindah halaman atas permintaan SW: lewat router (lunak) bila berprefiks bahasa, selain itu muat penuh. */
  const onNavigate = React.useEffectEvent((url: string) => {
    const match = url.match(/^\/(ja|en|id)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
    if (!match) {
      window.location.assign(url);
      return;
    }
    const [, locale, path = "/", search = "", hash = ""] = match;
    router.push(`${path}${search}${hash}`, { locale: locale as Locale });
  });

  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as Partial<SwNavigateMessage> | null;
      if (data?.type !== SW_NAVIGATE || typeof data.url !== "string") return;
      if (!data.url.startsWith("/") || data.url.startsWith("//")) return;
      onNavigate(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  if (pathname === "/app") return null;
  return <OfflineBadge variant="floating" />;
}
