import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "rp_locale";

/** Locale from the user's choice (cookie), else the browser, else Japanese (default market). */
export default getRequestConfig(async () => {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const accept = (await headers()).get("accept-language") ?? "";
  const locale: Locale =
    chosen === "en" || chosen === "ja" ? chosen : /^en\b/i.test(accept) ? "en" : "ja";
  const messages = (await import(`./messages/${locale}.json`)) as {
    default: Record<string, unknown>;
  };
  return { locale, messages: messages.default, timeZone: "Asia/Tokyo" };
});
