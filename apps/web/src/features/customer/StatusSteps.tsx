import { Icon } from "./ui";

/**
 * Vertical progress timeline for real order states only (no percentages, no estimates). Steps before `current` are
 * done, `current` is highlighted, later steps are upcoming. Each step is labelled in text, not color alone.
 */
export function StatusSteps({
  steps,
  current,
  label,
  stateLabels,
}: {
  steps: { key: string; label: string; detail?: string | undefined }[];
  current: number;
  label: string;
  stateLabels: { done: string; current: string; upcoming: string };
}) {
  return (
    <ol aria-label={label} className="relative">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "upcoming";
        const last = i === steps.length - 1;
        return (
          <li
            key={s.key}
            aria-current={state === "current" ? "step" : undefined}
            className="relative flex gap-3.5 pb-6 last:pb-0"
          >
            {!last && (
              <span
                aria-hidden
                className={`absolute top-7 bottom-1 left-[13px] w-0.5 rounded-full ${i < current ? "bg-brand" : "bg-line"}`}
              />
            )}
            <span
              aria-hidden
              className={`relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${
                state === "done"
                  ? "bg-brand text-white"
                  : state === "current"
                    ? "bg-brand text-white ring-4 ring-brand-tint"
                    : "bg-white text-placeholder ring-2 ring-line"
              }`}
            >
              {state === "done" ? (
                <Icon.Check className="size-3.5" />
              ) : state === "current" ? (
                <span className="size-2.5 rounded-full bg-white motion-safe:animate-pulse" />
              ) : (
                i + 1
              )}
            </span>
            <span className="min-w-0">
              <span
                className={`block text-[15px] leading-7 ${state === "upcoming" ? "text-muted" : state === "current" ? "font-bold text-ink" : "font-semibold text-ink-2"}`}
              >
                {s.label}
                <span className="sr-only"> ({stateLabels[state]})</span>
              </span>
              {state === "current" && s.detail && (
                <span className="mt-0.5 block text-[13px] text-ink-2">{s.detail}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
