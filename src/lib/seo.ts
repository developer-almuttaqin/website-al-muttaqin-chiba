import type { Metadata } from "next";
import { routing } from "@/i18n/routing";
import { siteName, siteUrl } from "@/lib/site";
import type { Lecture, Locale, MosqueEvent, MosqueProfile } from "@/lib/types";
import { pick } from "@/lib/utils/i18n";

/**
 * Metadata SEO per halaman. Tanpa ini setiap sub-halaman mewarisi canonical, hreflang, dan Open Graph
 * milik beranda dari layout, sehingga mesin pencari menganggap semua halaman sebagai duplikat beranda.
 */
const OG_LOCALE: Record<Locale, string> = { ja: "ja_JP", en: "en_US", id: "id_ID" };

export const DEFAULT_OG_IMAGE = { url: "/images/masjid/og.jpg", width: 1200, height: 630, alt: siteName };

/** URL mutlak sebuah halaman; `path` diawali "/" atau kosong untuk beranda. */
export function localeUrl(locale: string, path = ""): string {
  return `${siteUrl}/${locale}${path}`;
}

/** Canonical halaman ini dan hreflang ke versi bahasa lain dari halaman yang sama. */
export function alternatesFor(locale: string, path = ""): NonNullable<Metadata["alternates"]> {
  const languages: Record<string, string> = Object.fromEntries(routing.locales.map((l) => [l, localeUrl(l, path)]));
  languages["x-default"] = localeUrl(routing.defaultLocale, path);
  return { canonical: localeUrl(locale, path), languages };
}

export type PageSeo = {
  locale: string;
  /** Jalur tanpa awalan bahasa, mis. "/donate". Kosong untuk beranda. */
  path?: string;
  title: string;
  description?: string;
  /** Judul dipakai apa adanya, tanpa akhiran nama situs. */
  absoluteTitle?: boolean;
  image?: { url: string; width?: number; height?: number; alt?: string };
  type?: "website" | "article";
  publishedTime?: string;
  modifiedTime?: string;
  /**
   * Halaman App Jamaah yang isinya sama dengan halaman situs menunjuk ke halaman situs itu,
   * supaya yang muncul di hasil pencarian adalah halaman utamanya.
   */
  canonicalPath?: string;
  /** Halaman utilitas (pengaturan, menu) tidak perlu masuk indeks. */
  noindex?: boolean;
};

export function pageMetadata(seo: PageSeo): Metadata {
  const locale = (routing.locales as readonly string[]).includes(seo.locale) ? (seo.locale as Locale) : routing.defaultLocale;
  const path = seo.canonicalPath ?? seo.path ?? "";
  const url = localeUrl(locale, path);
  const image = seo.image ?? DEFAULT_OG_IMAGE;
  const base = {
    siteName,
    locale: OG_LOCALE[locale],
    alternateLocale: routing.locales.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
    url,
    title: seo.title,
    description: seo.description,
    images: [image],
  };
  return {
    title: seo.absoluteTitle ? { absolute: seo.title } : seo.title,
    description: seo.description,
    alternates: alternatesFor(locale, path),
    openGraph:
      seo.type === "article"
        ? { ...base, type: "article", publishedTime: seo.publishedTime, modifiedTime: seo.modifiedTime }
        : { ...base, type: "website" },
    twitter: { card: "summary_large_image", title: seo.title, description: seo.description, images: [image.url] },
    ...(seo.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/* ------------------------------ Data terstruktur (schema.org) ------------------------------ */

export type JsonLdNode = Record<string, unknown>;

const MOSQUE_ID = `${siteUrl}/#mosque`;
const abs = (url: string) => (url.startsWith("http") ? url : `${siteUrl}${url.startsWith("/") ? "" : "/"}${url}`);

/** Jejak navigasi: beranda, lalu tiap tingkat sampai halaman ini. */
export function breadcrumbLd(locale: string, trail: { name: string; path: string }[]): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [{ name: siteName, path: "" }, ...trail].map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: localeUrl(locale, item.path),
    })),
  };
}

function placeLd(profile: MosqueProfile, locale: Locale): JsonLdNode {
  return {
    "@type": "Place",
    name: pick(profile.name, locale),
    address: {
      "@type": "PostalAddress",
      streetAddress: pick(profile.address, locale),
      addressLocality: pick(profile.city, locale),
      addressRegion: pick(profile.prefecture, locale),
      postalCode: profile.postalCode,
      addressCountry: "JP",
    },
    geo: { "@type": "GeoCoordinates", latitude: profile.coordinates.lat, longitude: profile.coordinates.lng },
  };
}

/** Acara: memungkinkan tampil sebagai hasil kaya "Event" (tanggal, tempat) di pencarian. */
export function eventLd(event: MosqueEvent, locale: Locale, profile: MosqueProfile): JsonLdNode {
  const fee = event.registration.fee;
  const url = localeUrl(locale, `/events/${event.slug}`);
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: pick(event.title, locale),
    description: pick(event.excerpt, locale),
    startDate: event.startsAt,
    endDate: event.endsAt,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    inLanguage: event.languages,
    url,
    image: [abs(event.coverImage ?? DEFAULT_OG_IMAGE.url)],
    location: placeLd(profile, locale),
    organizer: { "@type": "Organization", "@id": MOSQUE_ID, name: pick(profile.name, locale), url: localeUrl(locale) },
    ...(event.speaker ? { performer: { "@type": "Person", name: event.speaker } } : {}),
    isAccessibleForFree: !fee || fee.amount === 0,
    ...(fee && fee.amount > 0
      ? { offers: { "@type": "Offer", price: fee.amount, priceCurrency: fee.currency, url, availability: "https://schema.org/InStock" } }
      : {}),
  };
}

/** Berita dan pengumuman. */
export function articleLd(input: {
  locale: Locale;
  path: string;
  headline: string;
  description: string;
  publishedAt: string;
  image?: string;
  author?: string;
  kind?: "NewsArticle" | "Article";
}): JsonLdNode {
  const url = localeUrl(input.locale, input.path);
  const publisher = { "@type": "Organization", "@id": MOSQUE_ID, name: siteName, logo: { "@type": "ImageObject", url: abs("/icons/icon-512.png") } };
  return {
    "@context": "https://schema.org",
    "@type": input.kind ?? "NewsArticle",
    headline: input.headline.slice(0, 110),
    description: input.description,
    datePublished: input.publishedAt,
    dateModified: input.publishedAt,
    inLanguage: input.locale,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    image: [abs(input.image ?? DEFAULT_OG_IMAGE.url)],
    author: input.author ? { "@type": "Person", name: input.author } : publisher,
    publisher,
  };
}

/** Rekaman kajian (YouTube): memungkinkan tampil sebagai hasil video. */
export function videoLd(lecture: Lecture, locale: Locale): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: pick(lecture.title, locale),
    description: pick(lecture.description, locale) || pick(lecture.title, locale),
    thumbnailUrl: [`https://i.ytimg.com/vi/${lecture.youtubeId}/hqdefault.jpg`],
    uploadDate: lecture.publishedAt,
    duration: `PT${Math.max(1, Math.round(lecture.durationMinutes))}M`,
    embedUrl: `https://www.youtube.com/embed/${lecture.youtubeId}`,
    contentUrl: `https://www.youtube.com/watch?v=${lecture.youtubeId}`,
    inLanguage: lecture.language,
    url: localeUrl(locale, `/lectures/${lecture.slug}`),
    publisher: { "@type": "Organization", "@id": MOSQUE_ID, name: siteName },
  };
}
