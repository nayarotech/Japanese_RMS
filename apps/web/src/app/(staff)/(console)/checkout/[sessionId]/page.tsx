"use client";
/**
 * Cash checkout (Figma "Checkout"). Displayed amounts come from the server bill. On submit the server
 * re-verifies the bill: if it changed (e.g. a guest ordered meanwhile) the payment is refused.
 */
import type {
  BillDto,
  CheckoutResultDto,
  SessionDetailResponse,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LangToggle } from "../../../../../components/LangToggle";
import { PageHeader } from "../../../../../components/PageHeader";
import { Banner, Button, Dialog, Spinner } from "../../../../../components/ui";
import { ApiError, errorKey, newIdempotencyKey, staffApi } from "../../../../../lib/api";
import { formatYen, pickSnapshotName, ratePercent } from "../../../../../lib/format";
import { useRealtime } from "../../../../../lib/realtime";

const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "C", "0", "00"] as const;
const MAX_DIGITS = 8;

export default function CheckoutPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [received, setReceived] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CheckoutResultDto | null>(null);
  const payKey = useRef(newIdempotencyKey());

  const load = useCallback(() => {
    staffApi
      .get<SessionDetailResponse>(`/sessions/${sessionId}`)
      .then(setDetail)
      .catch((err: unknown) => {
        setError(t(errorKey(err)));
      });
  }, [sessionId, t]);
  useEffect(load, [load]);
  useRealtime(
    ["order.created", "order.updated", "checkout.completed", "table.session.closed"],
    (_e, p) => {
      if (!done && (!p["tableSessionId"] || p["tableSessionId"] === sessionId)) load();
    },
  );

  const bill: BillDto | undefined = detail?.bill;
  const receivedYen = Number(received || "0");
  const due = bill?.totalYen ?? 0;
  const change = receivedYen - due;

  const press = (k: (typeof KEYS)[number]) => {
    setError(null);
    if (k === "C") setReceived("");
    else setReceived((r) => (r + k).replace(/^0+/, "").slice(0, MAX_DIGITS));
  };

  async function pay() {
    if (!bill) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const result = await staffApi.send<CheckoutResultDto>(
        "POST",
        `/sessions/${sessionId}/checkout/cash`,
        { amountReceivedYen: receivedYen, expectedTotalYen: bill.totalYen },
        { idempotencyKey: payKey.current },
      );
      setDone(result);
    } catch (err) {
      payKey.current = newIdempotencyKey();
      if (err instanceof ApiError && err.code === "bill_changed")
        setError(t("checkout.billChanged"));
      else if (err instanceof ApiError && err.code === "insufficient_cash")
        setError(t("checkout.insufficient"));
      else if (err instanceof ApiError && err.code === "session_closed")
        setError(t("checkout.alreadySettled"));
      else if (err instanceof ApiError && err.code === "nothing_to_pay")
        setError(t("checkout.nothingToPay"));
      else setError(t(errorKey(err)));
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!detail || !bill)
    return error ? (
      <div className="p-6">
        <Banner>{error}</Banner>
      </div>
    ) : (
      <Spinner label={t("common.loading")} />
    );
  const closed = detail.session.status === "closed";

  return (
    <>
      <PageHeader
        title={t("checkout.title")}
        left={
          <Link
            href="/tables"
            className="flex size-10 items-center justify-center rounded-[10px] border border-line"
            aria-label={t("common.back")}
          >
            ‹
          </Link>
        }
      >
        <span className="mr-auto text-[13px] text-muted">
          {detail.session.tableName} · #{String(detail.session.slipNo).padStart(4, "0")}
        </span>
        <LangToggle />
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section className="flex w-[420px] shrink-0 flex-col bg-canvas p-6">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] border border-line bg-white p-5">
            {bill.lines.map((l) => (
              <div
                key={l.orderItemId}
                className="flex items-start gap-3 border-b border-line-soft py-2.5 text-[14px]"
              >
                <span className="min-w-0 flex-1">
                  {pickSnapshotName(l.nameJa, l.nameEn, locale)}
                  {l.note && <span className="block text-[11px] text-muted">{l.note}</span>}
                </span>
                <span className="text-muted">×{l.quantity}</span>
                <span className="w-20 text-right font-semibold">
                  {formatYen(l.lineTotalYen, locale)}
                </span>
              </div>
            ))}
            <div className="mt-3 flex justify-between text-[13px] text-ink-2">
              <span>{bill.pricesIncludeTax ? t("pos.subtotal") : t("pos.subtotalExcl")}</span>
              <span>{formatYen(bill.subtotalYen, locale)}</span>
            </div>
            {bill.taxBreakdown.map((x) => (
              <div key={x.rateBp} className="mt-1 flex justify-between text-[13px] text-ink-2">
                <span>
                  {bill.pricesIncludeTax
                    ? t("pos.taxIncluded", { rate: ratePercent(x.rateBp) })
                    : t("pos.tax", { rate: ratePercent(x.rateBp) })}
                </span>
                <span>{formatYen(x.taxYen, locale)}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between rounded-[12px] bg-ink px-5 py-6 text-white">
            <span className="text-[15px] font-semibold">{t("checkout.amountDue")}</span>
            <span className="text-[36px] font-bold" data-testid="amount-due">
              {formatYen(due, locale)}
            </span>
          </div>
        </section>
        <section className="flex min-w-0 flex-1 flex-col gap-4 bg-white p-6">
          <div className="flex">
            <span className="flex h-16 w-40 items-center justify-center rounded-[12px] bg-brand text-[16px] font-semibold text-white">
              {t("checkout.cash")}
            </span>
          </div>
          {error && <Banner>{error}</Banner>}
          {closed && !done && <Banner tone="info">{t("checkout.alreadySettled")}</Banner>}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-[12px] border border-line p-4">
              <p className="text-[13px] text-muted">{t("checkout.received")}</p>
              <p className="text-[30px] font-bold" aria-live="polite">
                {formatYen(receivedYen, locale)}
              </p>
            </div>
            <div
              className={`rounded-[12px] p-4 ${change >= 0 && receivedYen > 0 ? "bg-brand-tint text-brand-dark" : "bg-chip text-muted"}`}
            >
              <p className="text-[13px]">{t("checkout.change")}</p>
              <p className="text-[30px] font-bold">
                {receivedYen > 0 && change >= 0 ? formatYen(change, locale) : "—"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: t("checkout.exact"), value: due },
              { label: formatYen(1000, locale), value: 1000 },
              { label: formatYen(5000, locale), value: 5000 },
              { label: formatYen(10000, locale), value: 10000 },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setReceived(String(p.value))}
                className="h-12 rounded-[10px] bg-chip text-[15px] font-semibold"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-3 gap-3">
            {KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => press(k)}
                aria-label={k === "C" ? t("checkout.clearKey") : k}
                className="min-h-14 rounded-[10px] border border-line bg-white text-[22px] font-semibold"
              >
                {k}
              </button>
            ))}
          </div>
          <Button
            variant="brand"
            className="h-16 text-[18px]"
            disabled={busy || closed || bill.totalYen <= 0 || receivedYen < due}
            onClick={() => setConfirming(true)}
          >
            {t("checkout.complete")}
          </Button>
        </section>
      </div>
      {confirming && (
        <Dialog title={t("checkout.complete")} onClose={() => setConfirming(false)}>
          <p className="text-[15px]">{t("checkout.confirm", { amount: formatYen(due, locale) })}</p>
          <p className="mt-1 text-[14px] text-muted">
            {t("checkout.changeDue", { amount: formatYen(Math.max(0, change), locale) })}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button className="h-12" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="brand" className="h-12" onClick={() => void pay()}>
              {t("common.confirm")}
            </Button>
          </div>
        </Dialog>
      )}
      {done && (
        <Dialog title={t("checkout.done")} onClose={() => router.push("/tables")}>
          <p className="text-[28px] font-bold">
            {t("checkout.changeDue", { amount: formatYen(done.changeYen, locale) })}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button className="h-12" onClick={() => router.push(`/receipts/${done.receiptId}`)}>
              {t("checkout.receipt")}
            </Button>
            <Button variant="dark" className="h-12" onClick={() => router.push("/tables")}>
              {t("checkout.backToTables")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
