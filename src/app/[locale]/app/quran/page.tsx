import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Locale } from "@/lib/types";
import { getSurahList } from "@/lib/data";
import { AppScreenHeader } from "@/components/app/shell";
import { SurahList } from "@/components/worship";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "quran" });
  return pageMetadata({ locale, path: "/app/quran", title: t("meta.title"), description: t("meta.description") });
}

export default async function QuranPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  setRequestLocale(raw);
  const locale = raw as Locale;
  const [t, ta, surahs] = await Promise.all([
    getTranslations({ locale, namespace: "quran" }),
    getTranslations({ locale, namespace: "app" }),
    getSurahList(),
  ]);

  return (
    <div>
      <AppScreenHeader title={t("title")} description={t("description")} backLabel={ta("back")} />
      <SurahList surahs={surahs} locale={locale} />
    </div>
  );
}
