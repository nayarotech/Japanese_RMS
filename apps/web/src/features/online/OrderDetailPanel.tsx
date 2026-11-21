"use client";
/**
 * Online order detail (staff). Shows lines with notes, money, fulfilment and payment state, history, and the actions
 * allowed for the current status. Customer contact data is fetched separately, on demand (audited server-side).
 */
import type { OnlineOrderContactDto, OnlineOrderDetailDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Spinner } from "../../components/ui";
import { newIdempotencyKey, staffApi } from "../../lib/api";
import {
  formatDateTime,
  formatTime,
  formatYen,
  pickSnapshotName,
  ratePercent,
} from "../../lib/format";
import { useStaff } from "../staff/StaffProvider";
import {
  CANCELLATION_REASONS,
  REJECTION_REASONS,
  CashInput,
  PaymentChip,
  ReasonDialog,
  StatusChip,
  onlineErrorKey,
  orderLabel,
} from "./shared";

export function OrderDetailPanel({
  id,
  refreshKey,
  onClose,
  onChanged,
}: {
  id: string;
  refreshKey: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { me, can } = useStaff();
  const tz = me.location.timeZone;
  const [order, setOrder] = useState<OnlineOrderDetailDto | null>(null);
  const [contact, setContact] = useState<OnlineOrderContactDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cash, setCash] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"reject" | "cancel" | null>(null);
  const [payKey, setPayKey] = useState(newIdempotencyKey);

  const load = useCallback(() => {
    staffApi
      .get<OnlineOrderDetailDto>(`/online-orders/${id}`)
      .then(setOrder)
      .catch((err: unknown) => setError(t(onlineErrorKey(err))));
  }, [id, t]);
  useEffect(load, [load, refreshKey]);
  useEffect(() => {
    setContact(null);
    setCash(null);
  }, [id]);

  async function act(path: string, body: object = {}, idempotent = false) {
    setBusy(true);
    setError(null);
    try {
      await staffApi.send(
        "POST",
        `/online-orders/${id}/${path}`,
        body,
        idempotent ? { idempotencyKey: payKey } : {},
      );
      if (idempotent) setPayKey(newIdempotencyKey());
      setCash(null);
      onChanged();
    } catch (err) {
      setError(t(onlineErrorKey(err)));
    } finally {
      setBusy(false);
      load();
    }
  }

  const showContact = () => {
    staffApi
      .get<OnlineOrderContactDto>(`/online-orders/${id}/contact`)
      .then(setContact)
      .catch((err: unknown) => setError(t(onlineErrorKey(err))));
  };

  if (!order) {
    return (
      <Panel onClose={onClose} title="">
        {error ? <Banner>{error}</Banner> : <Spinner label={t("common.loading")} />}
      </Panel>
    );
  }
  const o = order;
  const s = o.status;
  const cancellable = ["accepted", "preparing", "ready", "out_for_delivery"].includes(s);
  const managerOnly = ["preparing", "ready", "out_for_delivery"].includes(s);
  const canCancel = can("online_orders.manage") && (!managerOnly || can("online_orders.cancel"));
  const unpaid = o.paymentStatus === "unpaid";
  const enoughCash = cash !== null && cash >= o.totalYen;

  return (
    <Panel
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {orderLabel(o.orderNo)}
          <span className="rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-white">
            {t(`source.${o.fulfillmentType === "pickup" ? "ONLINE_PICKUP" : "ONLINE_DELIVERY"}`)}
          </span>
        </span>
      }
    >
      <div className="space-y-4">
        {error && <Banner>{error}</Banner>}
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={s} />
          <PaymentChip status={o.paymentStatus} />
          <span className="text-[13px] text-muted">{t(`paymentMethod.${o.paymentMethod}`)}</span>
        </div>
        <p className="text-[15px] font-semibold">
          {o.fulfillmentType === "pickup"
            ? t("online.pickupAt", { time: formatTime(o.scheduledFor, locale, tz) })
            : t("online.deliverBy", { time: formatTime(o.scheduledFor, locale, tz) })}
          {o.deliveryDistanceM !== null && (
            <span className="ml-2 text-[13px] font-normal text-muted">
              {t("online.distance", { km: (o.deliveryDistanceM / 1000).toFixed(1) })}
            </span>
          )}
        </p>
        {o.paymentStatus === "refund_required" && <Banner>{t("online.refundRequired")}</Banner>}
        {s === "delivered" && unpaid && <Banner tone="info">{t("online.deliveredUnpaid")}</Banner>}
        {(o.rejectionReason ?? o.cancellationReason) && (
          <Banner tone="info">
            {o.rejectionReason
              ? t(`rejectReason.${o.rejectionReason}`)
              : t(`cancelReason.${o.cancellationReason ?? "other"}`)}
          </Banner>
        )}

        <section>
          <h3 className="mb-1 text-[14px] font-semibold text-muted">{t("online.items")}</h3>
          <ul className="divide-y divide-line-soft">
            {o.items.map((i) => (
              <li
                key={i.id}
                className={`flex gap-3 py-2 ${i.status === "voided" ? "text-muted line-through" : ""}`}
              >
                <span className="w-8 font-bold">×{i.quantity}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{pickSnapshotName(i.nameJa, i.nameEn, locale)}</p>
                  {i.note && (
                    <p className="mt-0.5 inline-block rounded bg-brand-tint px-1.5 text-[12px] font-semibold text-brand">
                      {i.note}
                    </p>
                  )}
                </div>
                {i.kitchenStatus && (
                  <span className="text-[11px] text-muted">
                    {t(`kitchenStatus.${i.kitchenStatus}`)}
                  </span>
                )}
                <span className="w-20 text-right">{formatYen(i.lineTotalYen, locale)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t border-line pt-2 text-[14px]">
            <Row label={t("online.subtotal")} value={formatYen(o.itemsSubtotalYen, locale)} />
            {o.fulfillmentType === "delivery" && (
              <Row
                label={t("online.deliveryFee")}
                value={
                  o.deliveryFeeYen === 0 ? t("online.free") : formatYen(o.deliveryFeeYen, locale)
                }
              />
            )}
            {o.taxBreakdown.map((x) => (
              <Row
                key={x.rateBp}
                muted
                label={
                  o.pricesIncludeTax
                    ? t("online.taxIncluded", { rate: ratePercent(x.rateBp) })
                    : t("online.tax", { rate: ratePercent(x.rateBp) })
                }
                value={formatYen(x.taxYen, locale)}
              />
            ))}
            <div className="flex justify-between pt-1 text-[18px] font-bold">
              <dt>{t("online.total")}</dt>
              <dd>{formatYen(o.totalYen, locale)}</dd>
            </div>
          </dl>
          {o.payment && (
            <p className="mt-1 text-[13px] text-ok">
              {t("online.paidSummary", {
                amount: formatYen(o.payment.amountDueYen, locale),
                received: formatYen(o.payment.amountReceivedYen, locale),
                change: formatYen(o.payment.changeYen, locale),
              })}
            </p>
          )}
        </section>

        {o.canViewContact && (
          <section>
            <h3 className="mb-1 text-[14px] font-semibold text-muted">{t("online.customer")}</h3>
            {contact ? (
              <dl className="space-y-1 text-[14px]">
                <Row label={t("shop.name")} value={contact.name} />
                <Row
                  label={t("online.phone")}
                  value={<a href={`tel:${contact.phone}`}>{contact.phone}</a>}
                />
                {contact.email && <Row label={t("online.email")} value={contact.email} />}
                {contact.address && (
                  <>
                    <Row
                      label={t("online.address")}
                      value={`〒${contact.address.postalCode ?? ""} ${contact.address.prefecture ?? ""}${contact.address.city ?? ""}${contact.address.line1 ?? ""} ${contact.address.line2 ?? ""}`}
                    />
                    {contact.address.instructions && (
                      <Row label={t("online.instructions")} value={contact.address.instructions} />
                    )}
                  </>
                )}
              </dl>
            ) : (
              <Button className="h-10 px-3 text-[13px]" onClick={showContact}>
                {t("online.showCustomer")}
              </Button>
            )}
          </section>
        )}

        {/* ---- actions ---- */}
        <section className="space-y-2">
          {s === "pending_acceptance" && can("online_orders.manage") && (
            <div className="grid grid-cols-2 gap-2">
              <Button className="h-12" disabled={busy} onClick={() => setDialog("reject")}>
                {t("online.decline")}
              </Button>
              <Button
                variant="brand"
                className="h-12"
                disabled={busy}
                onClick={() => void act("accept")}
              >
                {t("online.accept")}
              </Button>
            </div>
          )}
          {(s === "accepted" || s === "preparing") && (
            <p className="text-[14px] text-muted">{t("online.waitingKitchen")}</p>
          )}
          {s === "ready" && o.fulfillmentType === "pickup" && can("online_orders.fulfill") && (
            <>
              {unpaid && can("checkout.perform") && (
                <CashInput due={o.totalYen} value={cash} onChange={setCash} />
              )}
              {(!unpaid || can("checkout.perform")) && (
                <Button
                  variant="brand"
                  className="h-12 w-full"
                  disabled={busy || (unpaid && !enoughCash)}
                  onClick={() =>
                    void act(
                      "complete",
                      unpaid ? { amountReceivedYen: cash, expectedTotalYen: o.totalYen } : {},
                      true,
                    )
                  }
                >
                  {unpaid ? t("online.handOverPay") : t("online.handOver")}
                </Button>
              )}
            </>
          )}
          {s === "ready" && o.fulfillmentType === "delivery" && can("online_orders.fulfill") && (
            <Button
              variant="dark"
              className="h-12 w-full"
              disabled={busy}
              onClick={() => void act("dispatch")}
            >
              {t("online.dispatch")}
            </Button>
          )}
          {s === "out_for_delivery" && can("online_orders.fulfill") && (
            <Button
              variant="brand"
              className="h-12 w-full"
              disabled={busy}
              onClick={() => void act("deliver")}
            >
              {t("online.delivered")}
            </Button>
          )}
          {unpaid && (s === "out_for_delivery" || s === "delivered") && can("checkout.perform") && (
            <>
              <CashInput due={o.totalYen} value={cash} onChange={setCash} />
              <Button
                variant="dark"
                className="h-12 w-full"
                disabled={busy || !enoughCash}
                onClick={() =>
                  void act(
                    "payments/cash",
                    { amountReceivedYen: cash, expectedTotalYen: o.totalYen },
                    true,
                  )
                }
              >
                {t("online.recordCash")}
              </Button>
            </>
          )}
          {cancellable && canCancel && (
            <Button
              className="h-11 w-full text-[14px]"
              disabled={busy}
              onClick={() => setDialog("cancel")}
            >
              {t("online.cancel")}
            </Button>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-[14px] font-semibold text-muted">{t("online.history")}</h3>
          <ol className="space-y-1 text-[13px] text-ink-2">
            {o.history.map((x, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-32 shrink-0 text-muted">{formatDateTime(x.at, locale, tz)}</span>
                <span>
                  {t(`onlineStatus.${x.to}`)}{" "}
                  <span className="text-muted">
                    (
                    {x.actorType === "staff"
                      ? t("online.actorStaff")
                      : x.actorType === "customer"
                        ? t("online.actorCustomer")
                        : t("online.actorSystem")}
                    )
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {dialog === "reject" && (
        <ReasonDialog
          title={t("online.declineTitle", { no: String(o.orderNo).padStart(4, "0") })}
          reasons={REJECTION_REASONS}
          namespace="rejectReason"
          onCancel={() => setDialog(null)}
          onConfirm={(reason, note) => {
            setDialog(null);
            void act("reject", { reason, note });
          }}
        />
      )}
      {dialog === "cancel" && (
        <ReasonDialog
          title={t("online.cancelTitle", { no: String(o.orderNo).padStart(4, "0") })}
          reasons={CANCELLATION_REASONS}
          namespace="cancelReason"
          onCancel={() => setDialog(null)}
          onConfirm={(reason, note) => {
            setDialog(null);
            void act("cancel", { reason, note });
          }}
        />
      )}
    </Panel>
  );
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-4 ${muted ? "text-muted" : ""}`}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function Panel({
  title,
  onClose,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("online");
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        className="flex h-full w-full max-w-[480px] flex-col bg-white shadow-xl"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <header className="flex h-[65px] shrink-0 items-center gap-3 border-b border-line-2 px-5">
          <h2 className="text-[20px] font-bold">{title}</h2>
          <Button className="ml-auto h-10 px-3 text-[13px]" onClick={onClose}>
            {t("close")}
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </aside>
    </div>
  );
}
