import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Inter, Noto_Sans_JP } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import { getBrand } from "../branding/brand";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const notoJp = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-noto-jp",
  display: "swap",
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    title: { default: brand.displayName, template: `%s | ${brand.displayName}` },
    applicationName: brand.displayName,
    icons: { icon: [{ url: "/brand-icon", type: "image/svg+xml" }] },
    robots: { index: false, follow: false },
    other: { google: "notranslate" },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#181d20" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, brand] = await Promise.all([getLocale(), getBrand()]);
  return (
    // translate="no": browser machine translation garbles operational UI (and brand names); the app ships ja/en itself.
    <html
      lang={locale}
      translate="no"
      className={`${inter.variable} ${notoJp.variable}`}
      style={{ "--color-brand": brand.primaryColor } as CSSProperties}
    >
      {/* Browser extensions often inject attributes into <body>; ignore only those attribute diffs. */}
      <body suppressHydrationWarning>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
