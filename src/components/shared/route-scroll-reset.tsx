"use client";

import * as React from "react";
import { usePathname } from "@/i18n/navigation";

/** Elemen tujuan #jangkar sudah ada (aturan pencarian sama dengan Next.js)? */
function hashTargetExists(): boolean {
  const raw = window.location.hash.slice(1);
  if (!raw) return false;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // escape rusak: pakai apa adanya
  }
  return id === "top" || document.getElementById(id) !== null || document.getElementsByName(id).length > 0;
}

/**
 * Setiap pindah halaman (klik tautan / router.push), posisi gulir langsung ke paling atas.
 *
 * Bawaan App Router hanya menggulir ke awal segmen yang berubah dan melewatkannya bila awal
 * segmen itu sudah terlihat, ditambah `scroll-behavior: smooth` di <html> membuat guliran
 * dianimasikan lalu terpotong, sehingga halaman baru terbuka "nanggung" di tengah. Komponen ini
 * menggulir ke (0, 0) secara instan setelah halaman baru dirender.
 *
 * Dikecualikan: tombol kembali/maju (posisi lama dipulihkan browser) dan URL dengan #jangkar yang
 * elemennya ada (browser/Next menggulir ke elemen tujuannya). Berlaku juga untuk `scroll={false}`
 * bila pathname berubah.
 */
export function RouteScrollReset() {
  const pathname = usePathname();
  const previous = React.useRef(pathname);
  /** Path tujuan tombol kembali/maju terakhir (null bila navigasi terakhir bukan dari riwayat). */
  const historyTarget = React.useRef<string | null>(null);

  React.useEffect(() => {
    const onPopState = () => {
      historyTarget.current = window.location.pathname;
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  React.useLayoutEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const popped = historyTarget.current;
    historyTarget.current = null;
    if (popped !== null && popped === window.location.pathname) return;
    // #jangkar yang tujuannya ada: biarkan browser/Next menggulir ke sana. Tujuan belum ada (mis.
    // ayat yang baru dimuat kemudian) atau tidak valid: mulai dari atas, bukan dari posisi lama.
    if (hashTargetExists()) return;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    // Sekali lagi setelah frame berikutnya: gambar/font yang baru dimuat bisa menggeser tata letak,
    // dan pengendali gulir bawaan Next berjalan di fase yang sama.
    const raf = window.requestAnimationFrame(() => {
      if (!hashTargetExists() && window.scrollY !== 0) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [pathname]);

  return null;
}
