"use client";
/** Small shared pieces of the staff Online screens: labels, status chips, error mapping, reason dialog, cash input. */
import type {
  CancellationReason,
  OnlineOrderStatus,
  OnlinePaymentStatus,
  RejectionReason,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog } from "../../components/ui";
import { ApiError, errorKey } from "../../lib/api";
import { formatYen } from "../../lib/format";

export const orderLabel = (no: number) => `#${String(no).padStart(4, "0")}`;

// Reason codes accepted by the API (contracts exports only their types: the web app never imports runtime values).
export const REJECTION_REASONS: readonly RejectionReason[] = [
  "store_busy",
  "item_unavailable",
  "outside_hours",
  "cannot_deliver",
  "other",
];
export const CANCELLATION_REASONS: readonly CancellationReason[] = [
  "customer_request",
  "no_show",
  "cannot_fulfill",
  "delivery_failed",
  "other",
];

const STATUS_TONE: Record<OnlineOrderStatus, string> = {
  pending_acceptance: "bg-brand text-white",
  accepted: "bg-chip text-ink-2",
  preparing: "bg-brand-tint text-brand",
  ready: "bg-ink text-white",
  out_for_delivery: "bg-ink text-white",
  delivered: "bg-green-50 text-ok",
  completed: "bg-green-50 text-ok",
  rejected: "bg-chip text-muted",
  cancelled: "bg-chip text-muted",
};

export function StatusChip({ status }: { status: OnlineOrderStatus }) {
  const t = useTranslations("onlineStatus");
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${STATUS_TONE[status]}`}>
      {t(status)}
    </span>
  );
}

export function PaymentChip({ status }: { status: OnlinePaymentStatus }) {
  const t = useTranslations("paymentStatus");
  const tone =
    status === "paid"
      ? "bg-green-50 text-ok"
      : status === "refund_required"
        ? "bg-brand text-white"
        : status === "unpaid"
          ? "bg-brand-tint text-brand-dark"
          : "bg-chip text-muted";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${tone}`}>
      {t(status)}
    </span>
  );
}

const CODE_KEYS: Record<string, string> = {
  insufficient_cash: "checkout.insufficient",
  bill_changed: "checkout.billChanged",
  already_paid: "checkout.alreadySettled",
  invalid_online_order_transition: "errors.conflict",
  delivery_not_configured: "online.deliveryNotConfigured",
  invalid_hours: "online.invalidHours",
  invalid_delivery_tiers: "online.invalidTiers",
  online_handover_required: "errors.online_handover_required",
};

/** Maps an API error to an i18n key, with the online-specific codes first. */
export function onlineErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    const k = CODE_KEYS[err.code];
    if (k) return k;
  }
  return errorKey(err);
}

/** Reason picker for declining or cancelling (a valid reason is required; "other" needs a note). */
export function ReasonDialog({
  title,
  reasons,
  namespace,
  onCancel,
  onConfirm,
}: {
  title: string;
  reasons: readonly string[];
  namespace: "rejectReason" | "cancelReason";
  onCancel: () => void;
  onConfirm: (reason: string, note: string | null) => void;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState<string>(reasons[0] ?? "other");
  const [note, setNote] = useState("");
  const needsNote = reason === "other" && note.trim() === "";
  return (
    <Dialog title={title} onClose={onCancel}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[14px] font-semibold">{t("online.reason")}</legend>
        {reasons.map((r) => (
          <label key={r} className="flex items-center gap-2 text-[15px]">
            <input
              type="radio"
              name="reason"
              value={r}
              checked={reason === r}
              onChange={() => setReason(r)}
              className="size-4 accent-brand"
            />
            {t(`${namespace}.${r}`)}
          </label>
        ))}
      </fieldset>
      <label className="mt-3 block text-[14px] font-medium">
        {t("online.note")}
        <textarea
          value={note}
          maxLength={150}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 h-20 w-full rounded-[10px] border border-line px-3 py-2"
        />
      </label>
      {needsNote && <p className="mt-1 text-[12px] text-brand-dark">{t("online.noteRequired")}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button className="h-12" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="brand"
          className="h-12"
          disabled={needsNote}
          onClick={() => onConfirm(reason, note.trim() || null)}
        >
          {t("common.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}

/** Cash received entry with quick amounts (Figma checkout): Exact / ¥1,000 / ¥5,000 / ¥10,000. */
export function CashInput({
  due,
  value,
  onChange,
}: {
  due: number;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const change = value !== null && value >= due ? value - due : null;
  return (
    <div className="space-y-2">
      <label className="block text-[13px] font-medium text-muted">
        {t("online.received")}
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Math.floor(Number(e.target.value)))
          }
          className="mt-1 h-12 w-full rounded-[10px] border border-line px-3 text-[18px] font-semibold"
        />
      </label>
      <div className="grid grid-cols-4 gap-2">
        {[due, 1000, 5000, 10000].map((amount, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onChange(amount)}
            className="h-10 rounded-[10px] border border-line bg-chip text-[13px] font-semibold"
          >
            {i === 0 ? t("checkout.exact") : formatYen(amount, locale)}
          </button>
        ))}
      </div>
      {change !== null && (
        <p className="text-[15px] font-semibold text-brand-dark">
          {t("online.change", { amount: formatYen(change, locale) })}
        </p>
      )}
    </div>
  );
}
