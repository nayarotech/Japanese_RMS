import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <main className="flex min-h-full items-center justify-center p-8">
      <p className="text-[16px] text-muted">{t("notFound")}</p>
    </main>
  );
}
