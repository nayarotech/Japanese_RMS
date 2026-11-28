"use client";
/**
 * Customer-facing primitives shared by the table-QR, storefront, checkout and tracking pages.
 * Colors come only from the theme tokens (globals.css); radii follow one scale:
 * controls 12px, cards 16px, sheets 24px, pills full.
 */
import type { ReactNode, SVGProps } from "react";

// ---------------------------------------------------------------- icons (stroke = currentColor)

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const Icon = {
  Bag: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="M5.5 8.5h13l-1.1 10.3a2 2 0 0 1-2 1.7H8.6a2 2 0 0 1-2-1.7L5.5 8.5Z" />
      <path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" />
    </svg>
  ),
  Close: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  Plus: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} strokeWidth={2.4} {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Minus: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} strokeWidth={2.4} {...p}>
      <path d="M5 12h14" />
    </svg>
  ),
  Back: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="M15 5 8 12l7 7" />
    </svg>
  ),
  Pin: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11Z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  ),
  Clock: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  Phone: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="M5 4h3l1.5 4-2 1.3a11 11 0 0 0 5.2 5.2l1.3-2L18 14v3a2 2 0 0 1-2 2A13 13 0 0 1 3 6a2 2 0 0 1 2-2Z" />
    </svg>
  ),
  Note: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="M5 4h14v12l-4 4H5z" />
      <path d="M9 9h6M9 13h4" />
    </svg>
  ),
  Check: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} strokeWidth={2.6} {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  ),
  Chevron: (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" {...base} {...p}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
};

// ---------------------------------------------------------------- controls

/** Pill quantity control with 44px targets. The number re-keys on change for a subtle pop. */
export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 99,
  labels,
  size = "md",
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  labels: { dec: string; inc: string };
  size?: "md" | "sm";
}) {
  const btn = size === "md" ? "size-11" : "size-10 sm:size-9 [@media(pointer:coarse)]:size-11";
  return (
    <div className="inline-flex shrink-0 items-center rounded-full bg-chip p-0.5">
      <button
        type="button"
        aria-label={labels.dec}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={`${btn} flex items-center justify-center rounded-full text-ink transition-[background-color,transform] hover:bg-white active:scale-90 disabled:text-placeholder disabled:hover:bg-transparent`}
      >
        <Icon.Minus className="size-4" />
      </button>
      <span
        key={value}
        aria-live="polite"
        className="rp-pop min-w-7 text-center text-[15px] font-bold tabular-nums"
      >
        {value}
      </span>
      <button
        type="button"
        aria-label={labels.inc}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={`${btn} flex items-center justify-center rounded-full text-ink transition-[background-color,transform] hover:bg-white active:scale-90 disabled:text-placeholder`}
      >
        <Icon.Plus className="size-4" />
      </button>
    </div>
  );
}

/** The one primary action style on customer pages (brand color from the theme). */
export const primaryButton =
  "flex h-14 w-full items-center justify-center gap-2 rounded-[16px] bg-brand px-5 text-[16px] font-bold text-white shadow-lg shadow-brand/20 transition-[background-color,transform,box-shadow] hover:bg-brand-dark active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none";

/** Secondary action (outline on white). */
export const secondaryButton =
  "flex h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-white px-4 text-[15px] font-semibold text-ink ring-1 ring-line transition-[background-color,transform] hover:bg-panel active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45";

export function Spinner({ light = false }: { light?: boolean }) {
  return (
    <span
      aria-hidden
      className={`size-4 animate-spin rounded-full border-2 motion-reduce:animate-none ${light ? "border-white/40 border-t-white" : "border-line border-t-ink"}`}
    />
  );
}

// ---------------------------------------------------------------- surfaces

/** A titled section card (checkout steps, tracking blocks). `step` shows a small number badge. */
export function SectionCard({
  title,
  step,
  action,
  children,
  id,
}: {
  title: ReactNode;
  step?: number;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-[20px] bg-white p-4 shadow-sm shadow-ink/5 ring-1 ring-line-soft sm:p-5"
    >
      <div className="mb-3.5 flex items-center gap-2.5">
        {step !== undefined && (
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-[12px] font-bold text-white"
          >
            {step}
          </span>
        )}
        <h2 id={id} className="min-w-0 flex-1 text-[17px] font-bold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function StatusPill({
  tone,
  children,
  dot = false,
}: {
  tone: "ok" | "brand" | "neutral" | "outline" | "dark";
  children: ReactNode;
  dot?: boolean;
}) {
  const tones = {
    ok: "bg-green-50 text-ok",
    brand: "bg-brand-tint text-brand-dark",
    neutral: "bg-chip text-ink-2",
    outline: "bg-white text-ink-2 ring-1 ring-line",
    dark: "bg-ink text-white",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] leading-none font-bold whitespace-nowrap ${tones[tone]}`}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-chip text-muted">
        {icon}
      </span>
      <p className="mt-3 text-[16px] font-bold">{title}</p>
      {hint && <p className="mt-1 max-w-[280px] text-[13px] leading-relaxed text-muted">{hint}</p>}
      {action && <div className="mt-4 w-full max-w-[280px]">{action}</div>}
    </div>
  );
}

/** Header cart access with a live count (phones/tablets; desktop shows the side panel instead). */
export function CartButton({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-chip text-ink transition-[background-color,transform] hover:bg-line active:scale-95 lg:hidden"
    >
      <Icon.Bag className="size-[22px]" />
      {count > 0 && (
        <span
          key={count}
          className="rp-pop absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] font-bold text-white ring-2 ring-white tabular-nums"
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- loading

function Bone({ className }: { className: string }) {
  return <span aria-hidden className={`rp-skeleton block rounded-[10px] ${className}`} />;
}

/** Page-shaped loading state (no layout jump when the data arrives). */
export function PageSkeleton({
  label,
  variant,
}: {
  label: string;
  variant: "store" | "table" | "status";
}) {
  return (
    <div role="status" aria-label={label} className="min-h-dvh bg-white">
      <div className="flex h-16 items-center gap-3 border-b border-line-soft px-4">
        <Bone className="size-10 rounded-[12px]" />
        <div className="flex-1 space-y-1.5">
          <Bone className="h-4 w-40" />
          <Bone className="h-3 w-24" />
        </div>
        <Bone className="h-10 w-24 rounded-full" />
      </div>
      <div className="mx-auto max-w-[760px] space-y-4 px-4 pt-4">
        {variant === "store" && (
          <Bone className="aspect-[16/6] max-h-[168px] w-full rounded-[20px]" />
        )}
        {variant === "status" ? (
          <>
            <Bone className="h-40 w-full rounded-[20px]" />
            <Bone className="h-64 w-full rounded-[20px]" />
          </>
        ) : (
          <>
            <Bone className="h-6 w-48" />
            <Bone className="h-12 w-full rounded-full" />
            <div className="flex gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Bone key={i} className="h-10 w-20 rounded-full" />
              ))}
            </div>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-4 py-2">
                <div className="flex-1 space-y-2">
                  <Bone className="h-4 w-3/4" />
                  <Bone className="h-3 w-full" />
                  <Bone className="h-4 w-16" />
                </div>
                <Bone className="size-[112px] rounded-[16px]" />
              </div>
            ))}
          </>
        )}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}
