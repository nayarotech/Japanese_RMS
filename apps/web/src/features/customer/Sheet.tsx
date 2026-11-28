"use client";
/**
 * Bottom sheet on phones, centered panel from `sm` up. Modal: Escape and the backdrop close it, focus moves inside
 * and returns to the opener, the page behind does not scroll. Content scrolls; `footer` stays pinned.
 */
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Icon } from "./ui";

export function Sheet({
  title,
  onClose,
  children,
  footer,
  hideTitle = false,
  closeLabel,
  wide = false,
  media,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Visually hide the heading (e.g. the item name is shown under its photo instead). */
  hideTitle?: boolean;
  closeLabel: string;
  wide?: boolean;
  /** Full-bleed visual at the top of the sheet (e.g. the dish photo); the close button floats over it. */
  media?: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key !== "Tab" || !panel.current) return;
      // Keep Tab inside the sheet.
      const f = panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, []);

  const close = (
    <button
      type="button"
      onClick={onClose}
      aria-label={closeLabel}
      className={`flex size-10 shrink-0 items-center justify-center rounded-full transition-[background-color,transform] active:scale-90 ${media ? "bg-white/95 text-ink shadow-md shadow-ink/15 hover:bg-white" : "bg-chip text-ink-2 hover:bg-line"}`}
    >
      <Icon.Close className="size-[18px]" />
    </button>
  );

  return (
    <div
      className="rp-fade fixed inset-0 z-50 flex items-end justify-center bg-ink/50 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`rp-sheet relative flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-[24px] bg-white shadow-2xl shadow-ink/30 outline-none sm:max-h-[min(88dvh,880px)] sm:rounded-[24px] ${wide ? "sm:max-w-[600px]" : "sm:max-w-[520px]"}`}
      >
        {/* Grab handle: a visual cue only (closing is by the button, backdrop or Escape). */}
        <span
          aria-hidden
          className={`absolute top-2 left-1/2 z-10 h-1 w-10 -translate-x-1/2 rounded-full sm:hidden ${media ? "bg-white/80" : "bg-line"}`}
        />
        {media ? (
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
        ) : (
          <div className="flex items-center gap-3 px-5 pt-5 pb-2">
            <h2
              id={titleId}
              className={hideTitle ? "sr-only" : "min-w-0 flex-1 text-[19px] font-bold"}
            >
              {title}
            </h2>
            <span className="ml-auto">{close}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {media && (
            <div className="relative">
              {media}
              <span className="absolute top-3 right-3">{close}</span>
            </div>
          )}
          {children}
        </div>
        {footer && (
          <div className="border-t border-line-soft bg-white px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
