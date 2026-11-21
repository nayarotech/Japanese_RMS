"use client";
/**
 * Customer order status. The tracking token is read from the URL FRAGMENT (`/order/status#<token>`), which browsers
 * never send to servers or in Referer headers. It is sent only in the X-Order-Token header and the socket handshake.
 * No personal data is shown here: the link may be forwarded.
 */
import type { OnlineOrderStatus, OnlineTrackingDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { LangToggle } from "../../../components/LangToggle";
import { Banner, ConfirmButton, Spinner } from "../../../components/ui";
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
  const locale = useLocale();
  const [token, setToken] = useState<string | null>(null);
  const [order, setOrder] = useState<OnlineTrackingDto | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "invalid">("loading");
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{43}$/.test(fromHash)) setToken(fromHash);
    else setState("invalid");
  }, []);

  const load = useCallback(() => {
    if (!token) return;
    publicRequest<OnlineTrackingDto>("GET", "/public/online-orders/current", { orderToken: token })
      .then((o) => {
        setOrder(o);
        setState("ok");
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
      setMessage({ tone: "error", text: t("errors.conflict") });
    }
    load();
  }

  if (state === "invalid")
    return (
      <main className="mx-auto max-w-[480px] p-6">
        <Banner>{t("shop.linkExpired")}</Banner>
      </main>
    );
  if (!order) return <Spinner label={t("common.loading")} />;

  const tz = order.store.timeZone;
  const steps = order.fulfillmentType === "pickup" ? PICKUP_STEPS : DELIVERY_STEPS;
  const current = steps.indexOf(order.status);
  const closed = order.status === "rejected" || order.status === "cancelled";
  const hintKey =
    order.status === "ready"
      ? `shop.statusHint_ready_${order.fulfillmentType}`
      : `shop.statusHint_${order.status}`;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-line-2 px-4 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-bold">{order.store.name}</h1>
          <span className="mt-0.5 inline-block rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-white">
            {t("shop.orderNo", { no: String(order.orderNo).padStart(4, "0") })}
          </span>
        </div>
        <div className="ml-auto">
          <LangToggle />
        </div>
      </header>
      <main className="flex-1 space-y-5 p-4">
        {!connected && !closed && <p className="text-[12px] text-muted">{t("shop.liveOff")}</p>}
        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <section className={`rounded-[16px] p-5 ${closed ? "bg-chip" : "bg-brand-tint"}`}>
          <p className="text-[13px] font-semibold text-muted">{t("shop.statusTitle")}</p>
          <p className={`text-[24px] font-bold ${closed ? "text-ink-2" : "text-brand-dark"}`}>
            {t(`onlineStatus.${order.status}`)}
          </p>
          <p className="mt-1 text-[15px]">{t(hintKey)}</p>
          {!closed && (
            <p className="mt-2 text-[15px] font-semibold">
              {order.fulfillmentType === "pickup"
                ? t("shop.pickupAt", { time: formatTime(order.scheduledFor, locale, tz) })
                : t("shop.deliverAround", { time: formatTime(order.scheduledFor, locale, tz) })}
            </p>
          )}
          {order.rejectionReason && (
            <p className="mt-2 text-[14px]">
              {t("shop.reasonLabel", { reason: t(`rejectReason.${order.rejectionReason}`) })}
            </p>
          )}
        </section>

        {!closed && (
          <ol className="flex items-center gap-1" aria-label={t("shop.statusTitle")}>
            {steps.map((s, i) => (
              <li
                key={s}
                aria-current={i === current ? "step" : undefined}
                title={t(`onlineStatus.${s}`)}
                className={`h-2 flex-1 rounded-full ${i <= current ? "bg-brand" : "bg-line"}`}
              />
            ))}
          </ol>
        )}

        <section>
          <h2 className="mb-2 text-[16px] font-bold">{t("shop.yourOrder")}</h2>
          <ul className="space-y-1 text-[14px]">
            {order.items.map((i) => (
              <li key={i.id} className="flex gap-2">
                <span className="font-semibold">×{i.quantity}</span>
                <span className="min-w-0 flex-1">
                  {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                  {i.note && <span className="block text-[12px] text-muted">{i.note}</span>}
                </span>
                <span>{formatYen(i.lineTotalYen, locale)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t border-line pt-2 text-[14px]">
            {order.fulfillmentType === "delivery" && (
              <div className="flex justify-between">
                <dt>{t("shop.deliveryFee")}</dt>
                <dd>
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
                <dd>{formatYen(x.taxYen, locale)}</dd>
              </div>
            ))}
            <div className="flex justify-between pt-1 text-[18px] font-bold">
              <dt>{t("shop.total")}</dt>
              <dd>{formatYen(order.totals.totalYen, locale)}</dd>
            </div>
            <div className="flex justify-between text-[13px]">
              <dt>{t(`paymentMethod.${order.paymentMethod}`)}</dt>
              <dd>{t(`paymentStatus.${order.paymentStatus}`)}</dd>
            </div>
          </dl>
        </section>

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
      </main>
    </div>
  );
}
