"use client";
/**
 * Customer page chrome: restaurant identity (logo or initial, name, branch/table line), language switch and an
 * optional action (cart). Restaurant branding sits inside the partner brand; the accent color, when set, only
 * re-tints this customer page (`accentStyle`).
 */
import type { MenuImageDto } from "@restaurant-platform/contracts";
import type { CSSProperties, ReactNode } from "react";
import { LangToggle } from "../../components/LangToggle";

/** Page-level re-tint for a restaurant accent color (already contrast-checked by the API). */
export function accentStyle(accent: string | null | undefined): CSSProperties {
  const base: Record<string, string> = { "--header-h": "64px" };
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return base;
  return {
    ...base,
    "--color-brand": accent,
    "--color-brand-tint": `color-mix(in srgb, ${accent} 10%, white)`,
    "--color-brand-dark": `color-mix(in srgb, ${accent} 80%, black)`,
  } as CSSProperties;
}

export function RestaurantMark({
  logo,
  name,
  className = "size-10 rounded-[11px] text-[17px]",
}: {
  logo: MenuImageDto | null;
  name: string;
  className?: string;
}) {
  if (logo)
    return (
      <img
        src={logo.thumbUrl}
        width={logo.thumbWidth}
        height={logo.thumbHeight}
        alt=""
        className={`shrink-0 bg-white object-contain ${className}`}
      />
    );
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-brand font-bold text-white ${className}`}
    >
      {Array.from(name)[0] ?? ""}
    </span>
  );
}

export function CustomerHeader({
  logo,
  name,
  subtitle,
  action,
}: {
  logo: MenuImageDto | null;
  name: string;
  subtitle?: ReactNode;
  /** Right-side action before the language switch (e.g. the cart button). */
  action?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 h-[var(--header-h)] border-b border-line-soft bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-[1180px] items-center gap-3 px-4 sm:px-6">
        {/* Below 360px the logo gives way to the name (the page hero shows the logo). */}
        <span className="contents max-[359px]:hidden">
          <RestaurantMark logo={logo} name={name} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-bold sm:text-[16px]">{name}</p>
          {subtitle && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[12px] text-muted">
              {subtitle}
            </div>
          )}
        </div>
        <LangToggle compact />
        {action}
      </div>
    </header>
  );
}
