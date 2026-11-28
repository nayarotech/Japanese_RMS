"use client";
/**
 * Dine-in table QR experience. Scanning the table's QR joins THAT table's current dining session (server-issued,
 * HttpOnly guest credential; ADR-0008). The guest can browse, add dishes with per-dish requests, send orders, follow
 * each dish's kitchen status and see the running bill of their own table only. Payment happens at the register.
 * Every price shown is a preview; the server prices orders from its own menu.
 */
import type {
  GuestSessionResponse,
  KitchenItemStatus,
  PublicTableResponse,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "../../../components/ui";
import { CartBar, CartPanel } from "../../../features/customer/CartPanel";
import { CustomerHeader, accentStyle } from "../../../features/customer/CustomerHeader";
import { ItemSheet } from "../../../features/customer/ItemSheet";
import { MenuBrowser } from "../../../features/customer/MenuBrowser";
import { Sheet } from "../../../features/customer/Sheet";
import { useCart } from "../../../features/customer/cart";
import type { CustomerMenuItem } from "../../../features/customer/types";
import {
  CartButton,
  EmptyState,
  Icon,
  PageSkeleton,
  Spinner,
  StatusPill,
  primaryButton,
} from "../../../features/customer/ui";
import { ApiError, errorKey, guestApi, newIdempotencyKey } from "../../../lib/api";
import { formatYen, pickSnapshotName, ratePercent } from "../../../lib/format";
import { useRealtime } from "../../../lib/realtime";

type Message = { tone: "error" | "ok" | "info"; text: string };
const STAGES: KitchenItemStatus[] = ["queued", "preparing", "ready", "served"];

export default function TableOrderingPage() {
  const { token } = useParams<{ token: string }>();
  const t = useTranslations();
  const tc = useTranslations("customer");
  const locale = useLocale();
  const [table, setTable] = useState<PublicTableResponse | null>(null);
  const [session, setSession] = useState<GuestSessionResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [view, setView] = useState<"menu" | "table">("menu");
  const [openItem, setOpenItem] = useState<CustomerMenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const orderKey = useRef(newIdempotencyKey());
  // Remembers that this phone was part of the dining session, so a closed session reads "settled", not "not seated".
  const [wasJoined, setWasJoined] = useState(false);

  const loadTable = useCallback(() => {
    guestApi
      .get<PublicTableResponse>(`/public/tables/${token}`)
      .then(setTable)
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400))
          setNotFound(true);
        else setMessage({ tone: "error", text: t(errorKey(err)) });
      });
  }, [token, t]);

  const loadSession = useCallback(() => {
    guestApi
      .get<GuestSessionResponse>("/public/session")
      .then((s) => {
        guestApi.setCsrf(s.csrfToken);
        setSession(s);
      })
      .catch(() => setSession(null));
  }, []);

  useEffect(() => {
    loadTable();
    loadSession();
  }, [loadTable, loadSession]);
  // Socket hints (this table's guest room only) trigger a refetch; reconnects reconcile; polling is the fallback.
  useRealtime(
    [
      "order.created",
      "order.updated",
      "kitchen.item.status_changed",
      "table.session.updated",
      "table.session.closed",
      "checkout.completed",
    ],
    () => {
      loadSession();
      loadTable();
    },
    table?.joined === true,
  );

  const joined = table?.joined === true && session !== null;
  useEffect(() => {
    if (joined) setWasJoined(true);
  }, [joined]);
  const settled = wasJoined && !joined && table?.sessionState !== "open";
  const canOrder = joined && table.orderingEnabled && session.sessionStatus === "open";

  const menuMap = useMemo(
    () =>
      table ? new Map(table.menu.flatMap((c) => c.items.map((i) => [i.id, i] as const))) : null,
    [table],
  );
  const cart = useCart(`rp_qr_cart:${token}`, menuMap, "session");
  const { clear: clearCart } = cart;
  useEffect(() => {
    if (settled) {
      clearCart();
      setCartOpen(false);
      setView("menu");
    }
  }, [settled, clearCart]);

  // Scan-to-order: opening the QR of a table joins its dining session automatically (no code).
  const joining = useRef(false);
  const join = useCallback(async () => {
    if (joining.current) return;
    joining.current = true;
    try {
      const r = await guestApi.send<{ csrfToken: string }>(
        "POST",
        `/public/tables/${token}/join`,
        {},
      );
      guestApi.setCsrf(r.csrfToken);
      loadTable();
      loadSession();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (code !== "no_active_session") setMessage({ tone: "error", text: t(errorKey(err)) });
      loadTable();
    } finally {
      joining.current = false;
    }
  }, [token, t, loadTable, loadSession]);
  // Auto-join exactly once per page load (never retry in a loop, e.g. when rate limited).
  const autoJoinTried = useRef(false);
  useEffect(() => {
    if (autoJoinTried.current || !table || wasJoined) return;
    if (table.orderingEnabled && table.sessionState !== "bill_requested" && !table.joined) {
      autoJoinTried.current = true;
      void join();
    }
  }, [table, join, wasJoined]);

  async function placeOrder() {
    if (!canOrder || cart.orderLines.length === 0 || cart.problems.length > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const placed = await guestApi.send<{ orderNo: number }>(
        "POST",
        "/public/session/orders",
        { items: cart.orderLines },
        { idempotencyKey: orderKey.current },
      );
      orderKey.current = newIdempotencyKey();
      cart.clear();
      setCartOpen(false);
      setView("table");
      setMessage({ tone: "ok", text: tc("dineIn.orderSent", { no: placed.orderNo }) });
      window.scrollTo({ top: 0 });
      loadSession();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      // The same idempotency key is kept for a retry, so a lost response can never create a second order.
      setMessage({
        tone: "error",
        text:
          code === "session_checkout_in_progress"
            ? t("guest.billRequested")
            : code === "session_closed" || code === "unauthenticated"
              ? t("guest.sessionClosed")
              : code === "item_unavailable" || code === "item_not_found"
                ? tc("itemsChangedRetry")
                : err instanceof ApiError && err.status === 0
                  ? tc("retrySafe")
                  : t(errorKey(err)),
      });
      loadTable();
      loadSession();
    } finally {
      setBusy(false);
    }
  }

  if (notFound)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-white">
        <EmptyState icon={<Icon.Bag className="size-6" />} title={t("guest.notFound")} />
      </main>
    );
  if (!table) return <PageSkeleton variant="table" label={t("common.loading")} />;

  const name = table.profile.displayName ?? table.location.name;
  const announcement =
    locale === "en"
      ? (table.profile.announcement.en ?? table.profile.announcement.ja)
      : table.profile.announcement.ja;
  const orders = session?.orders.filter((o) => o.items.length > 0) ?? [];
  const orderHint = !table.orderingEnabled
    ? t("guest.orderingDisabled")
    : settled
      ? t("guest.sessionClosed")
      : session?.sessionStatus === "bill_requested" || table.sessionState === "bill_requested"
        ? t("guest.billRequested")
        : tc("dineIn.notJoined");

  const placeButton = (
    <button
      type="button"
      disabled={busy || !canOrder || cart.orderLines.length === 0 || cart.problems.length > 0}
      onClick={() => void placeOrder()}
      className={primaryButton}
    >
      {busy && <Spinner light />}
      {busy ? t("guest.placing") : tc("dineIn.sendToKitchen")}
    </button>
  );
  const cartPanel = (
    <CartPanel
      cart={cart}
      totalLabel={t("guest.total")}
      footnote={tc("dineIn.payAtRegister")}
      action={placeButton}
    />
  );

  return (
    <div style={accentStyle(table.profile.accentColor)} className="min-h-dvh bg-white lg:bg-canvas">
      <CustomerHeader
        logo={table.profile.logo}
        name={name}
        subtitle={
          <>
            <span className="inline-flex shrink-0 items-center rounded-full bg-ink px-2 py-px text-[11px] font-bold text-white">
              {t("guest.table", { name: table.table.name })}
            </span>
            {table.profile.displayName && <span className="truncate">{table.location.name}</span>}
          </>
        }
        action={
          canOrder && view === "menu" ? (
            <CartButton
              count={cart.count}
              label={tc("cartButton", { count: cart.count })}
              onClick={() => setCartOpen(true)}
            />
          ) : undefined
        }
      />

      <div className="mx-auto max-w-[1180px] lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6 lg:px-6 lg:py-6">
        <main className="min-w-0 bg-white pb-32 lg:rounded-[24px] lg:pb-10 lg:shadow-sm lg:shadow-ink/5 lg:ring-1 lg:ring-line-soft">
          {(announcement ||
            message ||
            !table.orderingEnabled ||
            settled ||
            (joined && session.sessionStatus === "bill_requested")) && (
            <div className="space-y-2 px-4 pt-4 sm:px-6">
              {message && <Banner tone={message.tone}>{message.text}</Banner>}
              {!table.orderingEnabled && <Banner tone="info">{t("guest.orderingDisabled")}</Banner>}
              {settled && <Banner tone="ok">{t("guest.sessionClosed")}</Banner>}
              {!settled && joined && session.sessionStatus === "bill_requested" && (
                <Banner tone="info">{t("guest.billRequested")}</Banner>
              )}
              {announcement && (
                <p className="rounded-[14px] bg-panel px-4 py-3 text-[14px] leading-relaxed text-ink-2 ring-1 ring-line-soft">
                  {announcement}
                </p>
              )}
            </div>
          )}

          {joined && (
            <div className="px-4 pt-4 sm:px-6">
              <div
                role="tablist"
                aria-label={tc("dineIn.views")}
                className="grid grid-cols-2 gap-1 rounded-[18px] bg-chip p-1"
              >
                {(["menu", "table"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => setView(v)}
                    className={`flex h-11 items-center justify-center gap-1.5 rounded-[14px] text-[14px] font-bold transition-[background-color,box-shadow,color] ${view === v ? "bg-white text-ink shadow-sm shadow-ink/10 ring-1 ring-line-soft" : "text-ink-2 hover:bg-white/60"}`}
                  >
                    {v === "menu" ? tc("dineIn.menuTab") : tc("dineIn.tableTabLabel")}
                    {v === "table" && orders.length > 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] text-white tabular-nums">
                        {orders.length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {view === "menu" || !session ? (
            <MenuBrowser
              menu={table.menu}
              canOrder={canOrder}
              quantityOf={cart.quantityOf}
              onOpen={setOpenItem}
              onQuickAdd={(i) => cart.add(i, 1, "")}
            />
          ) : (
            <TableView
              session={session}
              orders={orders}
              canOrder={canOrder}
              onOrderMore={() => {
                setView("menu");
                setMessage(null);
              }}
            />
          )}
        </main>

        <aside className="hidden lg:block" aria-label={t("guest.yourOrder")}>
          <div className="sticky top-[calc(var(--header-h)+24px)] max-h-[calc(100dvh-var(--header-h)-48px)] overflow-y-auto rounded-[24px] bg-white shadow-sm shadow-ink/5 ring-1 ring-line-soft">
            <h2 className="px-5 pt-5 pb-1 text-[18px] font-bold">{t("guest.yourOrder")}</h2>
            {canOrder || cart.lines.length > 0 ? (
              cartPanel
            ) : (
              <p className="px-5 pt-1 pb-5 text-[14px] text-muted">{orderHint}</p>
            )}
          </div>
        </aside>
      </div>

      {view === "menu" && cart.lines.length > 0 && !cartOpen && (
        <CartBar
          count={cart.count}
          subtotal={cart.subtotal}
          label={tc("viewOrder")}
          onOpen={() => setCartOpen(true)}
        />
      )}
      {cartOpen && (
        <Sheet
          title={t("guest.yourOrder")}
          closeLabel={t("common.close")}
          onClose={() => setCartOpen(false)}
        >
          {cartPanel}
        </Sheet>
      )}
      {openItem && (
        <ItemSheet
          item={openItem}
          canOrder={canOrder}
          orderHint={orderHint}
          priceNote={tc("taxIncluded")}
          onClose={() => setOpenItem(null)}
          onAdd={(q, note) => {
            cart.add(openItem, q, note);
            setOpenItem(null);
          }}
        />
      )}
    </div>
  );
}

const STATUS_TONE = {
  queued: "outline",
  preparing: "brand",
  ready: "ok",
  served: "neutral",
} as const;

/** "Your table": this dining session's orders, each dish's kitchen status, and the running bill. */
function TableView({
  session,
  orders,
  canOrder,
  onOrderMore,
}: {
  session: GuestSessionResponse;
  orders: GuestSessionResponse["orders"];
  canOrder: boolean;
  onOrderMore: () => void;
}) {
  const t = useTranslations();
  const tc = useTranslations("customer");
  const locale = useLocale();
  const sessionTone =
    session.sessionStatus === "open"
      ? "ok"
      : session.sessionStatus === "bill_requested"
        ? "brand"
        : "neutral";
  return (
    <section className="rp-fade px-4 pt-6 sm:px-6" aria-labelledby="your-table">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="your-table" className="text-[22px] font-bold tracking-tight">
          {t("guest.table", { name: session.table.name })}
        </h2>
        <StatusPill tone={sessionTone} dot>
          {tc(`dineIn.session_${session.sessionStatus}`)}
        </StatusPill>
      </div>

      {orders.length === 0 ? (
        <EmptyState
          icon={<Icon.Note className="size-6" />}
          title={tc("dineIn.noOrders")}
          hint={tc("dineIn.noOrdersHint")}
        />
      ) : (
        <ol className="mt-4 space-y-3">
          {[...orders].reverse().map((o) => {
            const statuses = o.items.map((i) => i.kitchenStatus ?? "queued");
            // The order is only as far along as its least advanced dish.
            const stage = Math.min(...statuses.map((s) => Math.max(0, STAGES.indexOf(s))));
            const served = o.items.filter((i) => i.kitchenStatus === "served").length;
            const stageKey = STAGES[stage] ?? "queued";
            return (
              <li
                key={o.id}
                className="overflow-hidden rounded-[20px] bg-white shadow-sm shadow-ink/5 ring-1 ring-line-soft"
              >
                <div className="px-4 pt-4 pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[16px] font-bold">
                      {tc("dineIn.orderNo", { no: o.orderNo })}
                    </h3>
                    <span className="text-[12px] font-semibold text-muted">
                      {tc("dineIn.servedCount", { served, total: o.items.length })}
                    </span>
                  </div>
                  <div className="mt-3 flex gap-1" aria-hidden>
                    {STAGES.map((s, i) => (
                      <span
                        key={s}
                        className={`h-1.5 flex-1 rounded-full transition-colors ${i <= stage ? "bg-brand" : "bg-line"}`}
                      />
                    ))}
                  </div>
                  <p className="mt-2 text-[13px] font-semibold text-ink-2">
                    {tc("dineIn.orderStage", { stage: tc(`itemStatus.${stageKey}`) })}
                  </p>
                </div>
                <ul className="divide-y divide-line-soft border-t border-line-soft px-4">
                  {o.items.map((i) => {
                    const st = i.kitchenStatus ?? "queued";
                    const tone = st === "voided" ? "neutral" : STATUS_TONE[st];
                    return (
                      <li key={i.id} className="flex items-start gap-3 py-3">
                        <span className="mt-px w-7 shrink-0 text-[14px] font-bold text-muted tabular-nums">
                          ×{i.quantity}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] leading-snug font-semibold break-words [word-break:auto-phrase]">
                            {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                          </span>
                          {i.note && (
                            <span className="mt-1 flex items-start gap-1 text-[12px] break-words text-muted">
                              <Icon.Note className="mt-px size-3.5 shrink-0" />
                              {i.note}
                            </span>
                          )}
                        </span>
                        <StatusPill tone={tone}>
                          {tc(`itemStatus.${st === "voided" ? "queued" : st}`)}
                        </StatusPill>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      )}

      {orders.length > 0 && (
        <div className="mt-4 rounded-[20px] bg-panel px-4 py-4 ring-1 ring-line-soft">
          <h3 className="text-[15px] font-bold">{tc("dineIn.bill")}</h3>
          <dl className="mt-2 space-y-1 text-[14px]">
            {session.bill.taxBreakdown.map((x) => (
              <div key={x.rateBp} className="flex justify-between text-muted">
                <dt>
                  {session.bill.pricesIncludeTax
                    ? t("shop.taxIncluded", { rate: ratePercent(x.rateBp) })
                    : t("shop.tax", { rate: ratePercent(x.rateBp) })}
                </dt>
                <dd className="tabular-nums">{formatYen(x.taxYen, locale)}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-line pt-2">
              <dt className="font-bold">{t("guest.total")}</dt>
              <dd className="text-[24px] font-bold tabular-nums">
                {formatYen(session.bill.totalYen, locale)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[12px] text-muted">{tc("dineIn.payAtRegister")}</p>
        </div>
      )}

      {canOrder && (
        <button
          type="button"
          onClick={onOrderMore}
          className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-[16px] bg-ink text-[16px] font-bold text-white transition-transform active:scale-[0.98]"
        >
          <Icon.Plus className="size-5" />
          {t("guest.orderMore")}
        </button>
      )}
    </section>
  );
}
