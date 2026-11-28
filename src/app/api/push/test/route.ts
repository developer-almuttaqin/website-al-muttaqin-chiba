import { after } from "next/server";
import webpush from "web-push";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/lib/types";
import { getServiceClient } from "@/lib/supabase/server";
import type { ReminderPushPayload } from "@/components/pwa/reminders";

/**
 * Push uji dari server ke SATU perangkat (Pengaturan App > Tes dari server).
 *   POST { endpoint, delay? (detik, 0-30) } -> { ok, delay } | { ok: false, reason }
 * Memakai jalur yang sama dengan notifikasi adzan saat App tertutup (VAPID + layanan push browser),
 * jadi bila uji ini muncul, adzan juga akan muncul selama penjadwal tiap menit aktif.
 * Isi pesan tetap (tidak bisa diatur pemanggil) dan hanya dikirim ke endpoint yang sudah terdaftar
 * di `push_subscriptions`; dibatasi per IP dan per endpoint.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  endpoint: z.url().max(1000),
  delay: z.number().int().min(0).max(30).default(0),
});

type Row = { endpoint: string; keys: { p256dh?: string; auth?: string } | null; locale: string | null };

const WINDOW_MS = 60_000;
const MAX_PER_IP = 6;
const ENDPOINT_GAP_MS = 15_000;
const ipHits = new Map<string, { count: number; reset: number }>();
const endpointLast = new Map<string, number>();

function ipLimited(ip: string, now: number): boolean {
  if (ipHits.size > 5000) ipHits.clear();
  const entry = ipHits.get(ip);
  if (!entry || entry.reset < now) {
    ipHits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_IP;
}

/** Satu push uji per endpoint tiap 15 detik; dicatat hanya saat push benar-benar akan dikirim. */
function claimEndpoint(endpoint: string, now: number): boolean {
  if (endpointLast.size > 5000) endpointLast.clear();
  const last = endpointLast.get(endpoint);
  if (last !== undefined && now - last < ENDPOINT_GAP_MS) return false;
  endpointLast.set(endpoint, now);
  return true;
}

function toLocale(value: string | null): Locale {
  return value === "ja" || value === "en" || value === "id" ? value : "id";
}

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: "invalid" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, reason: "invalid" }, { status: 400 });
  const { endpoint, delay } = parsed.data;

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  if (ipLimited(ip, Date.now())) return Response.json({ ok: false, reason: "rate-limited" }, { status: 429 });

  const client = getServiceClient();
  if (!client) return Response.json({ ok: false, reason: "no-database" });
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return Response.json({ ok: false, reason: "no-vapid" });

  const { data, error } = await client.from("push_subscriptions").select("endpoint, keys, locale").eq("endpoint", endpoint).maybeSingle();
  if (error) return Response.json({ ok: false, reason: "database" }, { status: 500 });
  const row = data as Row | null;
  if (!row?.keys?.p256dh || !row.keys.auth) return Response.json({ ok: false, reason: "not-subscribed" });
  if (!claimEndpoint(row.endpoint, Date.now())) return Response.json({ ok: false, reason: "rate-limited" }, { status: 429 });

  const locale = toLocale(row.locale);
  const t = await getTranslations({ locale, namespace: "settings" });
  const notifyAt = new Date(Date.now() + delay * 1000).toISOString();
  const payload: ReminderPushPayload = {
    title: t("notify.serverTestTitle"),
    body: t("notify.serverTestBody"),
    url: `/${locale}/app/settings`,
    tag: "acc-test-server",
    kind: "test",
    notifyAt,
  };
  const subscription = { endpoint: row.endpoint, keys: { p256dh: row.keys.p256dh, auth: row.keys.auth } };
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:info@almuttaqinculturalcenter.org", publicKey, privateKey);

  const send = async (): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120, urgency: "high", topic: "acc-test" });
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number } | undefined)?.statusCode;
      if (!status) console.error("[push/test]", err instanceof Error ? err.message : err);
      if (status === 404 || status === 410) {
        await client.from("push_subscriptions").delete().eq("endpoint", row.endpoint);
        return { ok: false, reason: "expired", status };
      }
      // 401/403: langganan dibuat dengan kunci VAPID lain (kunci di server diganti).
      return { ok: false, reason: status === 401 || status === 403 ? "vapid-mismatch" : "send-failed", status };
    }
  };

  if (delay === 0) {
    const result = await send();
    return Response.json(result.ok ? { ok: true, delay: 0 } : result);
  }

  // Jawab segera, kirim setelah jeda: pengguna sempat menutup App / mengunci layar.
  after(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    const result = await send();
    if (!result.ok) console.error("[push/test] gagal", result.reason, result.status ?? "");
  });
  return Response.json({ ok: true, delay });
}
