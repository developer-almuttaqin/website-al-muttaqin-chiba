import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { Locale } from "@/lib/types";
import { AppScreenHeader, PoweredBy } from "@/components/app/shell";
import { SettingsPanel } from "@/components/pwa/settings-panel";
import pkg from "../../../../../package.json";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings" });
  return pageMetadata({ locale, path: "/app/settings", title: t("meta.title"), description: t("meta.description"), noindex: true });
}

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  setRequestLocale(raw);
  const locale = raw as Locale;
  const [t, ta] = await Promise.all([getTranslations({ locale, namespace: "settings" }), getTranslations({ locale, namespace: "app" })]);

  return (
    <div>
      <AppScreenHeader title={t("title")} description={t("description")} backLabel={ta("back")} />
      <SettingsPanel version={pkg.version} />
      <PoweredBy />
    </div>
  );
}
