const PRODUCTION_URL = "https://almuttaqinculturalcenter.org";

/**
 * URL publik situs; dipakai metadata, sitemap, manifest, dan JSON-LD.
 * Urutan: NEXT_PUBLIC_SITE_URL, lalu domain produksi. Di produksi tidak pernah jatuh ke localhost,
 * karena canonical dan sitemap yang menunjuk localhost membuat situs tidak terindeks.
 */
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || (process.env.NODE_ENV === "production" ? PRODUCTION_URL : "http://localhost:3000")).replace(/\/$/, "");

export const siteName = "Al Muttaqin Cultural Center";
