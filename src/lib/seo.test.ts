import { describe, expect, it } from "vitest";
import { alternatesFor, articleLd, breadcrumbLd, eventLd, pageMetadata, videoLd } from "./seo";
import { siteUrl } from "./site";
import type { Lecture, MosqueEvent, MosqueProfile } from "./types";

const l10n = (text: string) => ({ ja: text, en: text, id: text });

const profile = {
  name: l10n("Al Muttaqin Cultural Center"),
  address: l10n("1-2-3 Matsudo"),
  city: l10n("Matsudo"),
  prefecture: l10n("Chiba"),
  postalCode: "271-0000",
  coordinates: { lat: 35.78, lng: 139.9 },
} as MosqueProfile;

const event = {
  id: "e1",
  slug: "kajian-akhir-tahun",
  title: l10n("Kajian akhir tahun"),
  excerpt: l10n("Muhasabah diri"),
  description: { ja: [], en: [], id: [] },
  category: "kajian",
  startsAt: "2026-12-26T08:30:00.000Z",
  endsAt: "2026-12-26T10:00:00.000Z",
  location: l10n("Ruang salat utama"),
  languages: ["id"],
  registration: { required: false },
} as MosqueEvent;

describe("pageMetadata", () => {
  it("memberi canonical dan hreflang milik halaman itu sendiri, bukan milik beranda", () => {
    const meta = pageMetadata({ locale: "id", path: "/donate", title: "Infaq", description: "Rekening resmi" });
    expect(meta.alternates?.canonical).toBe(`${siteUrl}/id/donate`);
    expect(meta.alternates?.languages).toEqual({
      ja: `${siteUrl}/ja/donate`,
      en: `${siteUrl}/en/donate`,
      id: `${siteUrl}/id/donate`,
      "x-default": `${siteUrl}/en/donate`,
    });
  });

  it("mengisi Open Graph dan Twitter dengan judul, URL, dan gambar halaman", () => {
    const meta = pageMetadata({ locale: "ja", path: "/jumuah", title: "金曜礼拝", description: "今週の金曜礼拝" });
    const og = meta.openGraph as { url: string; title: string; locale: string; alternateLocale: string[]; images: { url: string }[] };
    expect(og.url).toBe(`${siteUrl}/ja/jumuah`);
    expect(og.title).toBe("金曜礼拝");
    expect(og.locale).toBe("ja_JP");
    expect(og.alternateLocale).toEqual(["en_US", "id_ID"]);
    expect(og.images[0].url).toBe("/images/masjid/og.jpg");
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", title: "金曜礼拝" });
  });

  it("beranda memakai judul apa adanya dan canonical tanpa garis miring di akhir", () => {
    const meta = pageMetadata({ locale: "en", path: "", title: "Al Muttaqin", absoluteTitle: true });
    expect(meta.title).toEqual({ absolute: "Al Muttaqin" });
    expect(meta.alternates?.canonical).toBe(`${siteUrl}/en`);
  });

  it("layar App kembaran halaman situs menunjuk ke halaman situs", () => {
    const meta = pageMetadata({ locale: "id", path: "/app/donate", canonicalPath: "/donate", title: "Infaq" });
    expect(meta.alternates?.canonical).toBe(`${siteUrl}/id/donate`);
    expect((meta.alternates?.languages as Record<string, string>).ja).toBe(`${siteUrl}/ja/donate`);
  });

  it("halaman utilitas tidak diindeks tetapi tautannya tetap diikuti", () => {
    expect(pageMetadata({ locale: "id", path: "/app/settings", title: "Pengaturan", noindex: true }).robots).toEqual({ index: false, follow: true });
    expect(pageMetadata({ locale: "id", path: "/about", title: "Tentang" }).robots).toBeUndefined();
  });

  it("artikel membawa tanggal terbit", () => {
    const meta = pageMetadata({ locale: "id", path: "/news/a", title: "A", type: "article", publishedTime: "2026-11-01T00:00:00.000Z" });
    expect(meta.openGraph).toMatchObject({ type: "article", publishedTime: "2026-11-01T00:00:00.000Z" });
  });

  it("bahasa yang tidak dikenal jatuh ke bahasa bawaan", () => {
    expect(alternatesFor("en", "/faq").canonical).toBe(`${siteUrl}/en/faq`);
    expect(pageMetadata({ locale: "xx", path: "/faq", title: "FAQ" }).alternates?.canonical).toBe(`${siteUrl}/en/faq`);
  });
});

describe("data terstruktur", () => {
  it("jejak navigasi selalu dimulai dari beranda dan bernomor urut", () => {
    const ld = breadcrumbLd("id", [{ name: "Agenda", path: "/events" }, { name: "Kajian", path: "/events/kajian" }]);
    const items = ld.itemListElement as { position: number; item: string }[];
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.item)).toEqual([`${siteUrl}/id`, `${siteUrl}/id/events`, `${siteUrl}/id/events/kajian`]);
  });

  it("acara gratis ditandai gratis dan tidak memuat harga", () => {
    const ld = eventLd(event, "id", profile);
    expect(ld).toMatchObject({ "@type": "Event", startDate: event.startsAt, endDate: event.endsAt, isAccessibleForFree: true });
    expect(ld.offers).toBeUndefined();
    expect(ld.url).toBe(`${siteUrl}/id/events/kajian-akhir-tahun`);
    expect((ld.image as string[])[0]).toBe(`${siteUrl}/images/masjid/og.jpg`);
  });

  it("acara berbayar memuat harga dalam mata uangnya sendiri", () => {
    const paid = { ...event, registration: { required: true, fee: { amount: 1500, currency: "JPY" as const } } };
    const ld = eventLd(paid, "ja", profile);
    expect(ld.isAccessibleForFree).toBe(false);
    expect(ld.offers).toMatchObject({ price: 1500, priceCurrency: "JPY" });
  });

  it("artikel memotong judul panjang dan selalu punya penerbit", () => {
    const ld = articleLd({ locale: "id", path: "/news/a", headline: "x".repeat(200), description: "d", publishedAt: "2026-11-01T00:00:00.000Z" });
    expect((ld.headline as string).length).toBe(110);
    expect(ld.publisher).toMatchObject({ "@type": "Organization" });
    expect(ld.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": `${siteUrl}/id/news/a` });
  });

  it("video kajian memuat durasi ISO 8601 dan tautan sematan YouTube", () => {
    const lecture = { id: "l1", slug: "tafsir", title: l10n("Tafsir"), speaker: "Ust", youtubeId: "abc123", publishedAt: "2026-10-01T00:00:00.000Z", durationMinutes: 47, description: l10n(""), language: "id", tags: [] } as Lecture;
    const ld = videoLd(lecture, "id");
    expect(ld).toMatchObject({ "@type": "VideoObject", duration: "PT47M", embedUrl: "https://www.youtube.com/embed/abc123", description: "Tafsir" });
  });
});
