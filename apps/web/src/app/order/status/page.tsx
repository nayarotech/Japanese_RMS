"use client";
/**
 * Online order confirmation + live tracking. The tracking token is read from the URL FRAGMENT (`/order/status#<token>`),
 * which browsers never send to servers or in Referer headers; it is sent only in the X-Order-Token header and the
 * tracking socket handshake (a room for this one order). The socket only carries "refresh" hints: the page always
 * re-reads the authoritative state over HTTP (also after reconnects, and every 15 s while disconnected).
 * No customer personal data is shown here: the link may be forwarded.
 */
import type { OnlineOrderStatus, OnlineTrackingDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Banner, ConfirmButton } from "../../../components/ui";
import { CustomerHeader, accentStyle } from "../../../features/customer/CustomerHeader";
import { StatusSteps } from "../../../features/customer/StatusSteps";
import {
  EmptyState,
  Icon,
  PageSkeleton,
  StatusPill,
  secondaryButton,
} from "../../../features/customer/ui";
import { type JustPlaced, readJustPlaced } from "../../../features/online/recent";
import { ApiError, publicRequest } from "../../../lib/api";
import { formatTime, formatYen, pickSnapshotName, ratePercent } from "../../../lib/format";
import { useOrderTracking } from "../../../lib/realtime";

const PICKUP_STEPS: OnlineOrderStatus[] = [
  "pending_acceptance",
  "accepted",
  "preparing",
  "ready",
  "completed",
];
const DELIVERY_STEPS: OnlineOrderStatus[] = [
  "pending_acceptance",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery",
  "delivered",
];

export default function OrderStatusPage() {
  const t = useTranslations();
  const tc = useTranslations("customer");
  const locale = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [order, setOrder] = useState<OnlineTrackingDto | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [placed, setPlaced] = useState<JustPlaced | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{43}$/.test(fromHash)) {
      setToken(fromHash);
      setPlaced(readJustPlaced(fromHash));
    } else setState("invalid");
  }, []);

  const load = useCallback(() => {
    if (!token) return;
    publicRequest<OnlineTrackingDto>("GET", "/public/online-orders/current", { orderToken: token })
      .then((o) => {
        setOrder(o);
        setState("ok");
        setMessage((m) => (m?.tone === "error" ? null : m));
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setState("invalid");
        else setMessage({ tone: "error", text: t("errors.network") });
      });
  }, [token, t]);
  useEffect(load, [load]);
  const { connected } = useOrderTracking(state === "ok" ? token : null, load);

  async function cancel() {
    if (!token) return;
    try {
      await publicRequest("POST", "/public/online-orders/current/cancel", {
        orderToken: token,
        body: {},
      });
      setMessage({ tone: "ok", text: t("shop.cancelled") });
    } catch {
      setMessage({ tone: "error", text: tc("tracking.cancelFailed") });
    }
    load();
  }

  if (state === "invalid")
    return (
      <main className="flex min-h-dvh items-center justify-center bg-white">
        <EmptyState icon={<Icon.Clock className="size-6" />} title={t("shop.linkExpired")} />
      </main>
    );
  if (!order) return <PageSkeleton variant="status" label={t("common.loading")} />;

  const tz = order.store.timeZone;
  const name = order.profile.displayName ?? order.store.name;
  const delivery = order.fulfillmentType === "delivery";
  const steps = delivery ? DELIVERY_STEPS : PICKUP_STEPS;
  const idx = steps.indexOf(order.status);
  // A delivery may also end as "completed"; treat it as the final step.
  const current = idx >= 0 ? idx : order.status === "completed" ? steps.length - 1 : 0;
  const finished = current === steps.length - 1;
  const closed = order.status === "rejected" || order.status === "cancelled";
  const hintKey =
    order.status === "ready"
      ? `shop.statusHint_ready_${order.fulfillmentType}`
      : `shop.statusHint_${order.status}`;
  const no = String(order.orderNo).padStart(4, "0");
  const address =
    locale === "en"
      ? (order.profile.address.en ?? order.profile.address.ja)
      : order.profile.address.ja;

  return (
    <div style={accentStyle(order.profile.accentColor)} className="min-h-dvh bg-canvas">
      <CustomerHeader
        logo={order.profile.logo}
        name={name}
        subtitle={order.profile.displayName ? order.store.name : undefined}
      />
      <main className="mx-auto max-w-[640px] space-y-4 px-4 pt-4 pb-12 sm:px-6">
        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        {placed && !closed && (
          <section
            className="rp-sheet rounded-[20px] bg-white p-6 text-center shadow-sm shadow-ink/5 ring-1 ring-line-soft"
            aria-live="polite"
          >
            <span
              aria-hidden
              className="rp-pop mx-auto flex size-14 items-center justify-center rounded-full bg-green-50 text-ok"
            >
              <Icon.Check className="size-7" />
            </span>
            <h1 className="mt-3 text-[22px] font-bold">{t("shop.placed")}</h1>
            <p className="mt-1 text-[14px] text-ink-2">{t("shop.placedHint")}</p>
            <p className="mt-3 text-[13px] text-muted">{tc("tracking.orderNumber")}</p>
            <p className="mt-1 text-[40px] leading-none font-bold tracking-wide tabular-nums">
              #{no}
            </p>
            <p className="mt-3 text-[12px] text-muted">{tc("tracking.keepLink")}</p>
          </section>
        )}

        <section
          aria-labelledby="status-title"
          className="rounded-[20px] bg-white p-5 shadow-sm shadow-ink/5 ring-1 ring-line-soft"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-muted">
                {placed && !closed ? t("shop.statusTitle") : t("shop.orderNo", { no })}
              </p>
              <h2
                id="status-title"
                className={`text-[24px] leading-tight font-bold ${closed ? "text-ink-2" : finished ? "text-ok" : "text-brand-dark"}`}
              >
                {t(`onlineStatus.${order.status}`)}
              </h2>
            </div>
            <StatusPill tone={connected ? "ok" : "neutral"} dot>
              {connected ? tc("tracking.live") : tc("tracking.reconnecting")}
            </StatusPill>
          </div>
          <p className="mt-1 text-[15px] text-ink-2">{t(hintKey)}</p>
          {order.rejectionReason && (
            <p className="mt-2 text-[14px]">
              {t("shop.reasonLabel", { reason: t(`rejectReason.${order.rejectionReason}`) })}
            </p>
          )}
          {closed && order.paymentStatus === "refund_required" && (
            <p className="mt-2 text-[14px] font-semibold">{tc("tracking.refundNote")}</p>
          )}
          {!closed && (
            <>
              <p className="mt-4 rounded-[12px] bg-panel px-4 py-3 text-[15px] font-semibold">
                {delivery
                  ? t("shop.deliverAround", { time: formatTime(order.scheduledFor, locale, tz) })
                  : t("shop.pickupAt", { time: formatTime(order.scheduledFor, locale, tz) })}
                <span className="block text-[12px] font-normal text-muted">
                  {t(`shop.${order.fulfillmentType}`)}
                  {!delivery && address ? ` · ${address}` : ""}
                </span>
              </p>
              <div className="mt-5">
                <StatusSteps
                  label={t("shop.statusTitle")}
                  current={current}
                  stateLabels={{
                    done: tc("tracking.stepDone"),
                    current: tc("tracking.stepCurrent"),
                    upcoming: tc("tracking.stepUpcoming"),
                  }}
                  steps={steps.map((s) => ({
                    key: s,
                    label: tc(`tracking.step_${s}`),
                    detail: s === order.status ? t(hintKey) : undefined,
                  }))}
                />
              </div>
            </>
          )}
        </section>

        <section
          aria-labelledby="payment"
          className="rounded-[20px] bg-white p-5 shadow-sm shadow-ink/5 ring-1 ring-line-soft"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id="payment" className="text-[16px] font-bold">
              {tc("tracking.payment")}
            </h2>
            <StatusPill tone={order.paymentStatus === "paid" ? "ok" : "outline"}>
              {t(`paymentStatus.${order.paymentStatus}`)}
            </StatusPill>
          </div>
          <p className="mt-1 text-[14px] text-ink-2">
            {t(`paymentMethod.${order.paymentMethod}`)} · {formatYen(order.totals.totalYen, locale)}
          </p>
        </section>

        <section
          aria-labelledby="items"
          className="rounded-[20px] bg-white p-5 shadow-sm shadow-ink/5 ring-1 ring-line-soft"
        >
          <h2 id="items" className="text-[16px] font-bold">
            {t("shop.yourOrder")}
          </h2>
          <ul className="mt-3 space-y-2 text-[14px]">
            {order.items.map((i) => (
              <li key={i.id} className="flex gap-2">
                <span className="w-7 shrink-0 font-bold tabular-nums">×{i.quantity}</span>
                <span className="min-w-0 flex-1 break-words">
                  {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                  {i.note && <span className="block text-[12px] text-muted">{i.note}</span>}
                </span>
                <span className="tabular-nums">{formatYen(i.lineTotalYen, locale)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-line pt-3 text-[14px]">
            <div className="flex justify-between">
              <dt>{t("shop.itemsSubtotal")}</dt>
              <dd className="tabular-nums">{formatYen(order.totals.itemsSubtotalYen, locale)}</dd>
            </div>
            {delivery && (
              <div className="flex justify-between">
                <dt>{t("shop.deliveryFee")}</dt>
                <dd className="tabular-nums">
                  {order.totals.deliveryFeeYen === 0
                    ? t("shop.free")
                    : formatYen(order.totals.deliveryFeeYen, locale)}
                </dd>
              </div>
            )}
            {order.totals.taxBreakdown.map((x) => (
              <div key={x.rateBp} className="flex justify-between text-muted">
                <dt>
                  {order.totals.pricesIncludeTax
                    ? t("shop.taxIncluded", { rate: ratePercent(x.rateBp) })
                    : t("shop.tax", { rate: ratePercent(x.rateBp) })}
                </dt>
                <dd className="tabular-nums">{formatYen(x.taxYen, locale)}</dd>
              </div>
            ))}
            <div className="flex justify-between pt-1 text-[18px] font-bold">
              <dt>{t("shop.total")}</dt>
              <dd className="tabular-nums">{formatYen(order.totals.totalYen, locale)}</dd>
            </div>
          </dl>
        </section>

        {order.profile.phone && (
          <p className="text-center text-[13px] text-ink-2">
            {tc("tracking.questions")}{" "}
            <a
              href={`tel:${order.profile.phone.replace(/[^0-9+]/g, "")}`}
              className="font-semibold underline underline-offset-2"
            >
              {order.profile.phone}
            </a>
          </p>
        )}

        {order.canCancel && (
          <ConfirmButton
            label={t("shop.cancelOrder")}
            message={t("shop.cancelConfirm")}
            confirmLabel={t("common.confirm")}
            cancelLabel={t("common.cancel")}
            onConfirm={() => void cancel()}
            className="h-12 w-full"
          />
        )}
        {placed && (
          <a href={`/order/${placed.storeToken}`} className={secondaryButton}>
            {t("shop.orderAgain")}
          </a>
        )}
      </main>
    </div>
  );
}
