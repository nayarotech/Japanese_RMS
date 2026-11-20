"use client";
import { useTranslations } from "next-intl";

/** Branded-neutral error boundary: no stack traces or framework details shown to users. */
export default function ErrorPage({ reset }: { reset: () => void }) {
  const t = useTranslations();
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
      <p className="text-[16px] text-muted">{t("errors.generic")}</p>
      <button
        type="button"
        className="rounded-[12px] bg-ink px-5 py-3 font-semibold text-white"
        onClick={reset}
      >
        {t("common.retry")}
      </button>
    </main>
  );
}
