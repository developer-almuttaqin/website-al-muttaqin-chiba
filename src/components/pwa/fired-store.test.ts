import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Cache Storage tiruan secukupnya (match / put / delete / keys) yang dipakai bersama "SW" dan "halaman". */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    const key = (req: RequestInfo | URL) => (typeof req === "string" ? req : req instanceof URL ? req.href : req.url);
    return {
      match: async (req: RequestInfo | URL) => store.get(key(req))?.clone(),
      put: async (req: RequestInfo | URL, res: Response) => void store.set(key(req), res),
      delete: async (req: RequestInfo | URL) => store.delete(key(req)),
      keys: async () => Array.from(store.keys()).map((u) => new Request(u)),
    } as unknown as Cache;
  };
  return { open } as unknown as CacheStorage;
}

describe("fired-store claimReminder", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("location", { origin: "https://example.test" });
    vi.stubGlobal("caches", fakeCaches());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lets only the first claimer of a tag win, across push (SW) and local (page) sources", async () => {
    const { claimReminder, wasClaimed } = await import("./fired-store");
    expect(await wasClaimed("adhan-dhuhr-2026-11-20")).toBe(false);
    expect(await claimReminder("adhan-dhuhr-2026-11-20", "push")).toBe(true);
    expect(await claimReminder("adhan-dhuhr-2026-11-20", "local")).toBe(false);
    expect(await claimReminder("adhan-dhuhr-2026-11-20", "push")).toBe(false);
    expect(await wasClaimed("adhan-dhuhr-2026-11-20")).toBe(true);
    expect(await claimReminder("adhan-asr-2026-11-20", "local")).toBe(true);
  });

  it("serialises concurrent claims so two simultaneous callers cannot both win", async () => {
    const { claimReminder } = await import("./fired-store");
    const results = await Promise.all([claimReminder("jumuah-dhuhr-2026-11-20", "push"), claimReminder("jumuah-dhuhr-2026-11-20", "local")]);
    // Tanpa Web Locks (Node), antrean internal tetap menjamin tepat satu pemenang.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimReminder("jumuah-dhuhr-2026-11-20", "local")).toBe(false);
  });

  it("forgets claims older than two days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T03:00:00Z"));
    const { claimReminder } = await import("./fired-store");
    expect(await claimReminder("adhan-fajr-2026-11-20", "push")).toBe(true);
    vi.setSystemTime(new Date("2026-11-23T03:00:00Z"));
    expect(await claimReminder("adhan-fajr-2026-11-20", "local")).toBe(true);
  });

  it("falls back to an in-memory log without Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    const { claimReminder } = await import("./fired-store");
    expect(await claimReminder("broadcast-1", "push")).toBe(true);
    expect(await claimReminder("broadcast-1", "local")).toBe(false);
  });
});
