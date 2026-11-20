/**
 * Catatan pengingat yang sudah dibunyikan, dipakai BERSAMA service worker dan halaman App.
 *
 * Masalah lama: push server (di SW) dan pengingat lokal (di halaman, lewat localStorage) tidak
 * saling tahu, sehingga satu waktu salat bisa memunculkan notifikasi beruntun dan App yang baru
 * dibuka tiba-tiba memutar adzan yang notifikasinya sudah tampil. Cache Storage tersedia di SW
 * maupun halaman, jadi dipakai sebagai catatan bersama: klaim PERTAMA untuk sebuah tag menang,
 * pemanggil berikutnya (sumber mana pun, tab mana pun) mendapat `false`.
 *
 * Tanpa impor runtime agar aman dibundel ke service worker.
 */

const CACHE_NAME = "acc-reminders-fired-v1";
const KEY_PATH = "/__acc/fired/";
const LOCK_NAME = "acc-reminder-claim";
const KEEP_MS = 2 * 24 * 60 * 60_000;
const AT_HEADER = "x-acc-at";
const LOCAL_KEY = "acc-reminder-fired";

export type ClaimSource = "push" | "local";

function keyFor(tag: string): string {
  return new URL(`${KEY_PATH}${encodeURIComponent(tag)}`, globalThis.location.origin).href;
}

/** Cadangan tanpa Cache Storage (http non-localhost, mode privat tertentu): memori + localStorage bila ada. */
const memory = new Map<string, number>();

function claimFallback(tag: string): boolean {
  const now = Date.now();
  for (const [t, at] of memory) if (now - at > KEEP_MS) memory.delete(t);
  if (memory.has(tag)) return false;
  let log: Record<string, number> = {};
  const storage = typeof localStorage === "undefined" ? null : localStorage;
  try {
    log = JSON.parse(storage?.getItem(LOCAL_KEY) ?? "{}") as Record<string, number>;
  } catch {
    log = {};
  }
  if (typeof log[tag] === "number" && now - log[tag] < KEEP_MS) {
    memory.set(tag, log[tag]);
    return false;
  }
  memory.set(tag, now);
  try {
    const next: Record<string, number> = { [tag]: now };
    for (const [t, at] of Object.entries(log)) if (typeof at === "number" && now - at < KEEP_MS) next[t] = at;
    storage?.setItem(LOCAL_KEY, JSON.stringify(next));
  } catch {
    // penyimpanan penuh / diblokir
  }
  return true;
}

async function prune(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  if (keys.length < 24) return;
  const now = Date.now();
  await Promise.all(
    keys.map(async (req) => {
      const res = await cache.match(req);
      const at = Number(res?.headers.get(AT_HEADER) ?? 0);
      if (!at || now - at > KEEP_MS) await cache.delete(req);
    }),
  );
}

async function claimInCache(tag: string, source: ClaimSource): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME);
  const key = keyFor(tag);
  const existing = await cache.match(key);
  const now = Date.now();
  if (existing) {
    const at = Number(existing.headers.get(AT_HEADER) ?? 0);
    if (at && now - at < KEEP_MS) return false;
  }
  await cache.put(key, new Response(JSON.stringify({ at: now, source }), { headers: { "content-type": "application/json", [AT_HEADER]: String(now) } }));
  void prune(cache).catch(() => undefined);
  return true;
}

/**
 * Klaim tag pengingat. `true` hanya untuk pemanggil pertama di perangkat ini (SW maupun tab mana pun).
 * Web Locks (tersedia di halaman dan worker) mencegah dua klaim bersamaan dari konteks berbeda
 * sama-sama menang; antrean internal melakukan hal yang sama di dalam satu konteks.
 */
export function claimReminder(tag: string, source: ClaimSource): Promise<boolean> {
  return serial(async () => {
    if (typeof caches === "undefined") return claimFallback(tag);
    const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
    try {
      if (locks?.request) return await locks.request(LOCK_NAME, () => claimInCache(tag, source));
      return await claimInCache(tag, source);
    } catch {
      return claimFallback(tag);
    }
  });
}

/** Antrean klaim di konteks yang sama (tab atau SW): tetap berurutan walau Web Locks tidak tersedia. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** Sudah pernah diklaim (tanpa mengklaim)? */
export async function wasClaimed(tag: string): Promise<boolean> {
  if (typeof caches === "undefined") return memory.has(tag);
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(keyFor(tag));
    const at = Number(res?.headers.get(AT_HEADER) ?? 0);
    return Boolean(at && Date.now() - at < KEEP_MS);
  } catch {
    return memory.has(tag);
  }
}
