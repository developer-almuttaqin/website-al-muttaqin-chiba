/** Domain produksi yang diberikan Vercel (domain kustom bila ada, kalau tidak alamat *.vercel.app). */
const vercelHost = process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;

/**
 * URL publik situs; dipakai canonical, sitemap, metadata, manifest, dan JSON-LD.
 * Urutan: NEXT_PUBLIC_SITE_URL, lalu domain produksi dari Vercel, lalu localhost (hanya saat pengembangan).
 * Di Vercel situs tidak pernah jatuh ke localhost: canonical dan sitemap yang menunjuk alamat yang
 * tidak bisa dibuka membuat situs tidak terindeks.
 */
export const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || (vercelHost ? `https://${vercelHost}` : "http://localhost:3000")).replace(/\/$/, "");

export const siteName = "Al Muttaqin Cultural Center";
