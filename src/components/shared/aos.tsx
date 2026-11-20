"use client";

import * as React from "react";

/**
 * Mesin AOS ringan (kompatibel dengan atribut `data-aos`, `data-aos-delay`, `data-aos-duration`
 * milik pustaka AOS), dipasang sekali di layout locale:
 * - konten tidak pernah disembunyikan sebelum JS berjalan: kelas `aos-ready` di <html> baru
 *   dipasang setelah elemen yang sudah terlihat (atau di atas layar) ditandai selesai tanpa animasi,
 *   sehingga tidak ada kedipan dan LCP tidak tertunda,
 * - elemen di bawah layar muncul dengan transisi saat masuk viewport (IntersectionObserver),
 * - konten baru setelah navigasi klien terdeteksi lewat MutationObserver (sebelum dilukis),
 * - setelah animasi selesai, kelas `aos-done` melepas transisi AOS agar hover/transisi milik
 *   elemen itu sendiri kembali normal,
 * - `prefers-reduced-motion: reduce` atau browser tanpa IntersectionObserver: tidak ada animasi.
 */

const SELECTOR = "[data-aos]";
const READY = "aos-ready";
const ANIMATE = "aos-animate";
const DONE = "aos-done";
const MAX_DELAY_MS = 600;
const DEFAULT_DURATION_MS = 700;

function readMs(value: string | undefined, max: number): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
}

export function AosRuntime() {
  React.useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window) || !("MutationObserver" in window)) return;
    const root = document.documentElement;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const seen = new WeakSet<Element>();
    const timers = new Set<number>();
    /** Elemen yang diamati dan belum muncul. */
    const pending = new Set<HTMLElement>();

    const finish = (el: HTMLElement) => {
      const delay = readMs(el.dataset.aosDelay, MAX_DELAY_MS) ?? 0;
      const duration = readMs(el.dataset.aosDuration, 3000) ?? DEFAULT_DURATION_MS;
      const id = window.setTimeout(() => {
        timers.delete(id);
        el.classList.add(DONE);
      }, delay + duration + 80);
      timers.add(id);
    };

    // Muncul saat >= 20% elemen terlihat, sudah menutupi >= 10% tinggi layar, atau elemennya tinggi
    // (>= setengah layar: ambang rasio belum tentu pernah tercapai lagi, jadi langsung dimunculkan).
    // Sengaja tanpa rootMargin negatif: elemen pendek di dasar halaman (mis. bilah hak cipta) tetap
    // bisa terpenuhi saat gulir mentok, sehingga tidak pernah tersembunyi selamanya.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const viewport = entry.rootBounds?.height ?? window.innerHeight;
          const tall = entry.boundingClientRect.height >= viewport * 0.5;
          if (!tall && entry.intersectionRatio < 0.2 && entry.intersectionRect.height < viewport * 0.1) continue;
          const el = entry.target as HTMLElement;
          io.unobserve(el);
          pending.delete(el);
          el.classList.add(ANIMATE);
          finish(el);
        }
      },
      { threshold: [0, 0.1, 0.2, 0.35] },
    );

    const prepare = (el: HTMLElement, initial: boolean) => {
      if (seen.has(el)) return;
      seen.add(el);
      const delay = readMs(el.dataset.aosDelay, MAX_DELAY_MS);
      const duration = readMs(el.dataset.aosDuration, 3000);
      if (delay) el.style.setProperty("--aos-delay", `${delay}ms`);
      if (duration) el.style.setProperty("--aos-duration", `${duration}ms`);
      // Muat awal: yang sudah terlihat atau berada di atas layar langsung dianggap selesai.
      if (initial && el.getBoundingClientRect().top < window.innerHeight) {
        el.classList.add(ANIMATE, DONE);
        return;
      }
      io.observe(el);
      pending.add(el);
    };

    // Jaring pengaman: gulir sangat cepat / lompat (tombol End, pemulihan posisi saat Kembali), atau
    // konten yang diganti React setelah gulir selesai, bisa membuat elemen tidak pernah tercatat masuk
    // layar. Setelah gulir berhenti (dan saat load), DOM diperiksa langsung: elemen yang sudah terlewat
    // (di atas layar) ditampilkan tanpa animasi, yang sedang terlihat dianimasikan masuk. Tidak
    // bergantung pada daftar internal, jadi node yang terlewat MutationObserver pun tertangani.
    let sweepTimer: number | undefined;
    const reveal = (el: HTMLElement, animate: boolean) => {
      seen.add(el);
      io.unobserve(el);
      pending.delete(el);
      if (animate) {
        el.classList.add(ANIMATE);
        finish(el);
      } else {
        el.classList.add(ANIMATE, DONE);
      }
    };
    const sweep = () => {
      for (const el of pending) {
        if (!el.isConnected) {
          io.unobserve(el);
          pending.delete(el);
        }
      }
      const viewport = window.innerHeight;
      document.querySelectorAll<HTMLElement>(`${SELECTOR}:not(.${ANIMATE})`).forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // tersembunyi (display: none): tunggu tampil
        if (rect.bottom <= 0) reveal(el, false);
        else if (rect.top < viewport) reveal(el, true);
      });
    };
    const scheduleSweep = (ms = 150) => {
      window.clearTimeout(sweepTimer);
      sweepTimer = window.setTimeout(sweep, ms);
    };
    const onScroll = () => scheduleSweep();
    const onLoad = () => scheduleSweep(300);

    const scan = (node: ParentNode, initial: boolean) => {
      if (node instanceof HTMLElement && node.matches(SELECTOR)) prepare(node, initial);
      node.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => prepare(el, initial));
    };

    const mo = new MutationObserver((records) => {
      let added = false;
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLElement) {
          const el = record.target;
          if (record.attributeName === "class") {
            // React menulis ulang className elemen yang sudah muncul: kembalikan tanpa animasi ulang.
            if (seen.has(el) && !pending.has(el) && el.matches(SELECTOR) && !el.classList.contains(ANIMATE)) el.classList.add(ANIMATE, DONE);
            continue;
          }
          prepare(el, false);
          added = true;
          continue;
        }
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement && (node.matches(SELECTOR) || node.querySelector(SELECTOR))) {
            scan(node, false);
            added = true;
          }
        });
      }
      // Konten baru (navigasi klien, atau React mengganti konten saat halaman sudah tergulir).
      if (added) scheduleSweep(250);
    });

    let running = false;
    const start = () => {
      if (running) return;
      running = true;
      scan(document, true);
      root.classList.add(READY);
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-aos", "class"] });
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
      window.addEventListener("load", onLoad);
      scheduleSweep(1200);
    };
    const stop = () => {
      running = false;
      mo.disconnect();
      io.disconnect();
      pending.clear();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("load", onLoad);
      window.clearTimeout(sweepTimer);
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      root.classList.remove(READY);
      // Pastikan semua elemen tampil bila gerak dimatikan di tengah jalan.
      document.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => el.classList.add(ANIMATE, DONE));
    };

    if (!motion.matches) start();
    const onMotionChange = () => (motion.matches ? stop() : undefined);
    motion.addEventListener("change", onMotionChange);
    return () => {
      motion.removeEventListener("change", onMotionChange);
      stop();
    };
  }, []);

  return null;
}
