"use client";
/**
 * Online orders (Figma "Online & delivery"): incoming queue with Accept/Decline on the right, active/recent orders on
 * the left, settings in a second tab (managers). Live via Socket.IO; always refetched from the API (missed events
 * are harmless).
 */
import type {
  OnlineOrderListResponse,
  OnlineOrderSummaryDto,
  RealtimeEvent,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { LangToggle } from "../../../../components/LangToggle";
import { PageHeader } from "../../../../components/PageHeader";
import { Banner, Button, Spinner } from "../../../../components/ui";
import { OrderDetailPanel } from "../../../../features/online/OrderDetailPanel";
import { SettingsForm } from "../../../../features/online/SettingsForm";
import {
  PaymentChip,
  StatusChip,
  onlineErrorKey,
  orderLabel,
} from "../../../../features/online/shared";
import { useStaff } from "../../../../features/staff/StaffProvider";
import { staffApi } from "../../../../lib/api";
import { formatTime, formatYen, pickSnapshotName } from "../../../../lib/format";
import { useRealtime } from "../../../../lib/realtime";

const EVENTS: RealtimeEvent[] = [
  "online.order.created",
  "online.order.accepted",
  "online.order.rejected",
  "online.order.cancelled",
  "online.order.preparing",
  "online.order.ready",
  "online.order.dispatched",
  "online.order.delivered",
  "online.order.completed",
  "online.order.payment_recorded",
];

export default function OnlineOrdersPage() {
  const t = useTranslations();
  const { can } = useStaff();
  const [tab, setTab] = useState<"orders" | "settings">("orders");
  const [scope, setScope] = useState<"active" | "recent">("active");
  const [data, setData] = useState<OnlineOrderListResponse | null>(null);
  const [incoming, setIncoming] = useState<OnlineOrderSummaryDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    Promise.all([
      staffApi.get<OnlineOrderListResponse>(`/online-orders?scope=${scope}`),
      scope === "active"
        ? Promise.resolve(null)
        : staffApi.get<OnlineOrderListResponse>("/online-orders?scope=active"),
    ])
      .then(([list, active]) => {
        setData(list);
        setIncoming((active ?? list).orders.filter((o) => o.status === "pending_acceptance"));
        setError(null);
        setTick((x) => x + 1);
      })
      .catch((err: unknown) => setError(t(onlineErrorKey(err))));
  }, [scope, t]);
  useEffect(load, [load]);
  const { connected } = useRealtime(EVENTS, (event, payload) => {
    if (event === "online.order.created" && typeof payload["orderNo"] === "number") {
      setAlert(t("online.newOrderAlert", { no: String(payload["orderNo"]).padStart(4, "0") }));
    }
    load();
  });

  async function quick(id: string, action: "accept") {
    try {
      await staffApi.send("POST", `/online-orders/${id}/${action}`);
    } catch (err) {
      setError(t(onlineErrorKey(err)));
    }
    load();
  }

  async function togglePause(paused: boolean) {
    try {
      await staffApi.send("POST", paused ? "/online/resume" : "/online/pause");
    } catch (err) {
      setError(t(onlineErrorKey(err)));
    }
    load();
  }

  const board = (data?.orders ?? []).filter(
    (o) => scope === "recent" || o.status !== "pending_acceptance",
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-baseline gap-3">
            {t("online.title")}
            <span className="hidden text-[14px] font-normal text-muted lg:inline">
              {t("online.subtitle")}
            </span>
          </span>
        }
      >
        {can("online_settings.manage") && (
          <div role="tablist" className="flex items-center gap-1 rounded-[12px] bg-chip p-1">
            {(["orders", "settings"] as const).map((x) => (
              <button
                key={x}
                role="tab"
                type="button"
                aria-selected={tab === x}
                onClick={() => setTab(x)}
                className={`h-9 rounded-[9px] px-4 text-[13px] font-semibold ${tab === x ? "bg-white text-ink shadow-sm" : "text-ink-2"}`}
              >
                {t(x === "orders" ? "online.tabOrders" : "online.tabSettings")}
              </button>
            ))}
          </div>
        )}
        <LangToggle />
      </PageHeader>
      {!connected && (
        <div className="bg-chip px-6 py-1.5 text-[12px] text-muted">{t("common.reconnecting")}</div>
      )}
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-y-auto bg-canvas p-6">
          {tab === "settings" ? (
            <SettingsForm />
          ) : (
            <OrdersBoard
              orders={board}
              loading={!data}
              error={error}
              scope={scope}
              setScope={setScope}
              ordering={data?.ordering ?? null}
              canPause={can("online_orders.manage")}
              onTogglePause={(paused) => void togglePause(paused)}
              onSelect={setSelected}
            />
          )}
        </section>
        <aside className="hidden w-[340px] shrink-0 flex-col border-l border-line-2 bg-white lg:flex">
          <h2 className="flex items-center justify-between px-5 pt-5 pb-3 text-[18px] font-bold">
            {t("online.incoming")}
            <span className="rounded-full bg-brand px-2.5 text-[14px] text-white">
              {incoming.length}
            </span>
          </h2>
          {alert && (
            <button type="button" onClick={() => setAlert(null)} className="mx-5 mb-2 text-left">
              <Banner tone="ok">{alert}</Banner>
            </button>
          )}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-5">
            {incoming.length === 0 && (
              <p className="text-[14px] text-muted">{t("online.noIncoming")}</p>
            )}
            {incoming.map((o) => (
              <IncomingCard
                key={o.id}
                order={o}
                canManage={can("online_orders.manage")}
                onOpen={() => setSelected(o.id)}
                onAccept={() => void quick(o.id, "accept")}
              />
            ))}
          </div>
        </aside>
      </div>
      {selected && (
        <OrderDetailPanel
          id={selected}
          refreshKey={tick}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function OrdersBoard({
  orders,
  loading,
  error,
  scope,
  setScope,
  ordering,
  canPause,
  onTogglePause,
  onSelect,
}: {
  orders: OnlineOrderSummaryDto[];
  loading: boolean;
  error: string | null;
  scope: "active" | "recent";
  setScope: (s: "active" | "recent") => void;
  ordering: { enabled: boolean; paused: boolean } | null;
  canPause: boolean;
  onTogglePause: (paused: boolean) => void;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" className="flex items-center gap-1 rounded-[12px] bg-white p-1">
          {(["active", "recent"] as const).map((x) => (
            <button
              key={x}
              role="tab"
              type="button"
              aria-selected={scope === x}
              onClick={() => setScope(x)}
              className={`h-9 rounded-[9px] px-4 text-[13px] font-semibold ${scope === x ? "bg-ink text-white" : "text-ink-2"}`}
            >
              {t(`online.${x}`)}
            </button>
          ))}
        </div>
        {ordering && (
          <span className="ml-auto flex items-center gap-3 text-[14px] font-semibold">
            <span
              className={`size-2.5 rounded-full ${!ordering.enabled ? "bg-placeholder" : ordering.paused ? "bg-brand" : "bg-ok"}`}
            />
            {!ordering.enabled
              ? t("online.orderingOff")
              : ordering.paused
                ? t("online.orderingPaused")
                : t("online.orderingOpen")}
            {canPause && ordering.enabled && (
              <Button
                variant={ordering.paused ? "brand" : "outline"}
                className="h-10 px-4 text-[13px]"
                onClick={() => onTogglePause(ordering.paused)}
              >
                {ordering.paused ? t("online.resume") : t("online.pause")}
              </Button>
            )}
          </span>
        )}
      </div>
      {error && <Banner>{error}</Banner>}
      {loading ? (
        <Spinner label={t("common.loading")} />
      ) : orders.length === 0 ? (
        <p className="text-[14px] text-muted">{t("online.noOrders")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((o) => (
            <OrderCard key={o.id} order={o} onOpen={() => onSelect(o.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrderCard({ order: o, onOpen }: { order: OnlineOrderSummaryDto; onOpen: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const { me } = useStaff();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-[14px] border border-line bg-white p-4 text-left hover:border-ink"
    >
      <div className="flex items-center gap-2">
        <span className="text-[18px] font-bold">{orderLabel(o.orderNo)}</span>
        <TypeBadge type={o.fulfillmentType} />
        <span className="ml-auto">
          <StatusChip status={o.status} />
        </span>
      </div>
      <ItemsLine items={o.items} locale={locale} />
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <span>
          {o.fulfillmentType === "pickup"
            ? t("online.pickupAt", {
                time: formatTime(o.scheduledFor, locale, me.location.timeZone),
              })
            : t("online.deliverBy", {
                time: formatTime(o.scheduledFor, locale, me.location.timeZone),
              })}
        </span>
        <PaymentChip status={o.paymentStatus} />
        <span className="ml-auto text-[16px] font-bold text-ink">
          {formatYen(o.totalYen, locale)}
        </span>
      </div>
    </button>
  );
}

function IncomingCard({
  order: o,
  canManage,
  onOpen,
  onAccept,
}: {
  order: OnlineOrderSummaryDto;
  canManage: boolean;
  onOpen: () => void;
  onAccept: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { me } = useStaff();
  return (
    <article className="space-y-2 rounded-[14px] border border-line p-4">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="flex items-center justify-between">
          <span className="text-[18px] font-bold">{orderLabel(o.orderNo)}</span>
          <TypeBadge type={o.fulfillmentType} />
        </div>
        <ItemsLine items={o.items} locale={locale} />
        <div className="mt-1 flex items-center justify-between text-[13px] text-muted">
          <span>
            {o.deliveryDistanceM !== null && `${(o.deliveryDistanceM / 1000).toFixed(1)} km · `}
            {formatTime(o.scheduledFor, locale, me.location.timeZone)}
          </span>
          <span className="text-[17px] font-bold text-ink">{formatYen(o.totalYen, locale)}</span>
        </div>
      </button>
      {canManage && (
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-12" onClick={onOpen}>
            {t("online.decline")}
          </Button>
          <Button variant="brand" className="h-12" onClick={onAccept}>
            {t("online.accept")}
          </Button>
        </div>
      )}
    </article>
  );
}

function TypeBadge({ type }: { type: "pickup" | "delivery" }) {
  const t = useTranslations("source");
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${type === "delivery" ? "bg-ink text-white" : "bg-chip text-ink-2"}`}
    >
      {t(type === "pickup" ? "ONLINE_PICKUP" : "ONLINE_DELIVERY")}
    </span>
  );
}

function ItemsLine({ items, locale }: { items: OnlineOrderSummaryDto["items"]; locale: string }) {
  return (
    <p className="line-clamp-2 text-[14px] text-ink-2">
      {items
        .map((i) => `${pickSnapshotName(i.nameJa, i.nameEn, locale)} ×${String(i.quantity)}`)
        .join(", ")}
    </p>
  );
}
