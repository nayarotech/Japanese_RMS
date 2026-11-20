"use client";
/** Small, accessible, brand-neutral UI primitives styled with the Figma tokens. */
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";

type Variant = "brand" | "dark" | "outline" | "ghost";
const VARIANTS: Record<Variant, string> = {
  brand: "bg-brand text-white hover:bg-brand-dark disabled:opacity-50",
  dark: "bg-ink text-white hover:bg-black disabled:opacity-50",
  outline: "bg-white text-ink-2 border border-line hover:bg-chip disabled:opacity-50",
  ghost: "bg-transparent text-ink-2 hover:bg-chip disabled:opacity-50",
};

export function Button({
  variant = "outline",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-[12px] font-semibold transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "brand" | "dark" | "light";
  children: ReactNode;
}) {
  const tones = {
    neutral: "bg-chip text-ink-2",
    brand: "bg-brand text-white",
    dark: "bg-ink text-white",
    light: "bg-white text-ink",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 p-8 text-muted">
      <span
        className="size-5 animate-spin rounded-full border-2 border-line border-t-brand"
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}

export function Banner({
  tone = "error",
  children,
}: {
  tone?: "error" | "info" | "ok";
  children: ReactNode;
}) {
  const tones = {
    error: "bg-brand-tint text-brand-dark",
    info: "bg-chip text-ink-2",
    ok: "bg-green-50 text-ok",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-[10px] px-4 py-3 text-[14px] font-medium ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-[16px] bg-white p-5 shadow-xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2 className="mb-4 text-[18px] font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Quantity stepper matching the Figma "−  2  +" control (44px touch targets). */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99,
  labels,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  labels: { dec: string; inc: string };
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={labels.dec}
        className="size-11 rounded-[10px] border border-line bg-white text-[20px]"
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="w-5 text-center text-[15px] font-semibold tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={labels.inc}
        className="size-11 rounded-[10px] border border-line bg-white text-[20px]"
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

/** Button that asks for confirmation in an in-app dialog (no blocking browser dialogs). */
export function ConfirmButton({
  label,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  variant = "outline",
  className = "",
}: {
  label: ReactNode;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  variant?: Variant;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <Dialog
          title={typeof label === "string" ? label : confirmLabel}
          onClose={() => setOpen(false)}
        >
          <p className="text-[15px] text-ink-2">{message}</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button className="h-12" onClick={() => setOpen(false)}>
              {cancelLabel}
            </Button>
            <Button
              variant="brand"
              className="h-12"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
