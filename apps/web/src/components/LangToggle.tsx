"use client";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

/** 日本語 / EN pill from the Figma header. Stores the choice in a cookie and re-renders server messages. */
export function LangToggle({
  dark = false,
  compact = false,
}: {
  dark?: boolean;
  compact?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("lang");
  const router = useRouter();
  const set = (l: "ja" | "en") => {
    document.cookie = `rp_locale=${l}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };
  const base = dark ? "bg-white/10" : "bg-chip";
  const active = dark ? "bg-white text-ink" : "bg-ink text-white";
  const idle = dark ? "text-white/80" : "text-ink-2";
  return (
    <div
      role="group"
      aria-label={t("label")}
      className={`flex items-center rounded-full p-[3px] ${compact ? "h-10" : "h-[42px]"} ${base}`}
    >
      {(["ja", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => set(l)}
          className={`rounded-full font-bold whitespace-nowrap transition-colors ${compact ? "h-[34px] px-3 text-[12px]" : "h-9 px-4 text-[13px]"} ${locale === l ? active : idle}`}
        >
          {t(l)}
        </button>
      ))}
    </div>
  );
}
