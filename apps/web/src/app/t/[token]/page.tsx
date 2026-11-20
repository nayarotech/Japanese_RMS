"use client";
/**
 * Customer QR menu (Figma "Guest QR menu (phone)"). No account. Viewing the menu needs only the printed
 * QR; ordering needs the table code that staff give to the seated party (see docs/security/qr-ordering.md).
 * Every price shown is a preview; the server recalculates totals from its own menu.
 */
import type { GuestSessionResponse, PublicTableResponse } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LangToggle } from "../../../components/LangToggle";
import { Banner, Spinner, Stepper } from "../../../components/ui";
import { ApiError, errorKey, guestApi, newIdempotencyKey } from "../../../lib/api";
import { formatYen, pickName, pickSnapshotName } from "../../../lib/format";
import { useRealtime } from "../../../lib/realtime";

type MenuItem = PublicTableResponse["menu"][number]["items"][number];
interface CartLine {
  key: string;
  item: MenuItem;
  quantity: number;
  note: string;
}

export default function GuestMenuPage() {
  const { token } = useParams<{ token: string }>();
  const t = useTranslations();
  const locale = useLocale();
  const [table, setTable] = useState<PublicTableResponse | null>(null);
  const [session, setSession] = useState<GuestSessionResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [view, setView] = useState<"menu" | "cart" | "orders">("menu");
  const [message, setMessage] = useState<{ tone: "error" | "ok" | "info"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const orderKey = useRef(newIdempotencyKey());
  // Remembers that this phone was part of the dining session, so a closed session reads "settled", not "not seated".
  const [wasJoined, setWasJoined] = useState(false);

  const loadTable = useCallback(() => {
    guestApi
      .get<PublicTableResponse>(`/public/tables/${token}`)
      .then((r) => {
        setTable(r);
        setCategory((c) => c ?? r.menu[0]?.id ?? null);
      })
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
      .catch(() => {
        setSession(null);
      });
  }, []);

  useEffect(() => {
    loadTable();
    loadSession();
  }, [loadTable, loadSession]);
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
  useEffect(() => {
    if (settled) {
      setMessage(null);
      setCart([]);
      setView("menu");
    }
  }, [settled]);
  const canOrder = joined && table.orderingEnabled && session.sessionStatus === "open";
  const items = useMemo(
    () => table?.menu.find((c) => c.id === category)?.items ?? [],
    [table, category],
  );
  const count = cart.reduce((s, l) => s + l.quantity, 0);
  const total = cart.reduce((s, l) => s + l.item.priceYen * l.quantity, 0);

  const add = (item: MenuItem) => {
    if (!item.isAvailable) return;
    setCart((c) => {
      const plain = c.find((l) => l.item.id === item.id && l.note === "");
      if (plain)
        return c.map((l) => (l === plain ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l));
      return [...c, { key: crypto.randomUUID(), item, quantity: 1, note: "" }];
    });
  };
  const update = (key: string, patch: Partial<CartLine>) =>
    setCart((c) =>
      c.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0),
    );
  /** Duplicate a line so the same dish can carry a different request (e.g. one less spicy, one extra noodles). */
  const split = (key: string) =>
    setCart((c) =>
      c.flatMap((l) =>
        l.key === key && l.quantity > 1
          ? [
              { ...l, quantity: l.quantity - 1 },
              { key: crypto.randomUUID(), item: l.item, quantity: 1, note: "" },
            ]
          : [l],
      ),
    );

  // Scan-to-order: opening the QR of a seated table joins its dining session automatically (no code).
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
    if (!canOrder || cart.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await guestApi.send(
        "POST",
        "/public/session/orders",
        {
          items: cart.map((l) => ({
            menuItemId: l.item.id,
            quantity: l.quantity,
            note: l.note.trim() || null,
          })),
        },
        { idempotencyKey: orderKey.current },
      );
      orderKey.current = newIdempotencyKey();
      setCart([]);
      setView("orders");
      setMessage({ tone: "ok", text: t("guest.orderPlaced") });
      loadSession();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setMessage({
        tone: "error",
        text:
          code === "session_checkout_in_progress"
            ? t("guest.billRequested")
            : code === "session_closed" || code === "unauthenticated"
              ? t("guest.sessionClosed")
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
      <main className="p-6">
        <Banner>{t("guest.notFound")}</Banner>
      </main>
    );
  if (!table) return <Spinner label={t("common.loading")} />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line-2 bg-white px-4 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-bold">{table.location.name}</h1>
          <span className="mt-0.5 inline-block rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-white">
            {t("guest.table", { name: table.table.name })}
          </span>
        </div>
        <div className="ml-auto">
          <LangToggle />
        </div>
      </header>

      <main className="flex-1 pb-28">
        {message && (
          <div className="px-4 pt-3">
            <Banner tone={message.tone}>{message.text}</Banner>
          </div>
        )}
        {!table.orderingEnabled && (
          <div className="px-4 pt-3">
            <Banner tone="info">{t("guest.orderingDisabled")}</Banner>
          </div>
        )}
        {settled && (
          <div className="px-4 pt-3">
            <Banner tone="ok">{t("guest.sessionClosed")}</Banner>
          </div>
        )}
        {joined && session.sessionStatus === "bill_requested" && (
          <div className="px-4 pt-3">
            <Banner tone="info">{t("guest.billRequested")}</Banner>
          </div>
        )}

        {view === "menu" && (
          <>
            <nav className="flex gap-2 overflow-x-auto px-4 py-3" aria-label="categories">
              {table.menu.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={c.id === category}
                  onClick={() => setCategory(c.id)}
                  className={`h-11 shrink-0 rounded-full border px-4 text-[14px] font-semibold ${c.id === category ? "border-brand bg-brand text-white" : "border-line text-ink-2"}`}
                >
                  {pickName(c.name, locale)}
                </button>
              ))}
              {joined && (
                <button
                  type="button"
                  onClick={() => setView("orders")}
                  className="h-11 shrink-0 rounded-full border border-ink px-4 text-[14px] font-semibold text-ink"
                >
                  {t("guest.myOrders")}
                </button>
              )}
            </nav>
            <ul className="px-4">
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 border-b border-line-soft py-3">
                  <span className="flex size-[72px] shrink-0 items-center justify-center rounded-[12px] bg-brand-tint text-[24px] font-bold text-brand">
                    {pickName(i.name, locale).slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-semibold">{pickName(i.name, locale)}</p>
                    {(locale === "en" ? i.description.en : i.description.ja) && (
                      <p className="text-[13px] text-muted">
                        {locale === "en" ? i.description.en : i.description.ja}
                      </p>
                    )}
                    <p className="text-[16px] font-bold">
                      {i.isAvailable ? formatYen(i.priceYen, locale) : t("guest.soldOut")}
                    </p>
                  </div>
                  {canOrder && (
                    <button
                      type="button"
                      disabled={!i.isAvailable}
                      onClick={() => add(i)}
                      aria-label={t("guest.add", { name: pickName(i.name, locale) })}
                      className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-[22px] text-white disabled:opacity-40"
                    >
                      +
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {view === "cart" && (
          <section className="px-4 pt-3">
            <h2 className="mb-2 text-[18px] font-bold">{t("guest.yourOrder")}</h2>
            {cart.length === 0 ? (
              <p className="text-[14px] text-muted">{t("guest.empty")}</p>
            ) : (
              cart.map((l) => (
                <div key={l.key} className="border-b border-line-soft py-3">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-[15px] font-semibold">
                      {pickName(l.item.name, locale)}
                    </p>
                    <Stepper
                      value={l.quantity}
                      onChange={(q) => update(l.key, { quantity: q })}
                      labels={{ dec: t("common.decrease"), inc: t("common.increase") }}
                    />
                  </div>
                  <input
                    value={l.note}
                    maxLength={140}
                    onChange={(e) => update(l.key, { note: e.target.value })}
                    placeholder={t("guest.notePlaceholder")}
                    aria-label={t("guest.notePlaceholder")}
                    className="mt-2 h-10 w-full rounded-[8px] border border-line bg-panel px-3 text-[14px]"
                  />
                  {l.quantity > 1 && (
                    <button
                      type="button"
                      onClick={() => split(l.key)}
                      className="mt-1 text-[12px] font-semibold text-brand"
                    >
                      + {t("guest.separateRequest")}
                    </button>
                  )}
                </div>
              ))
            )}
            <div className="mt-4 flex items-center justify-between text-[16px] font-bold">
              <span>{t("guest.total")}</span>
              <span>{formatYen(total, locale)}</span>
            </div>
            <button
              type="button"
              disabled={busy || cart.length === 0 || !canOrder}
              onClick={() => void placeOrder()}
              className="mt-4 h-14 w-full rounded-[14px] bg-brand text-[16px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? t("guest.placing") : t("guest.placeOrder")}
            </button>
            <button
              type="button"
              onClick={() => setView("menu")}
              className="mt-2 h-12 w-full text-[14px] font-semibold text-ink-2"
            >
              {t("common.back")}
            </button>
          </section>
        )}

        {view === "orders" && session && (
          <section className="px-4 pt-3">
            <h2 className="mb-2 text-[18px] font-bold">{t("guest.myOrders")}</h2>
            {session.orders.map((o) => (
              <div key={o.id} className="mb-3 rounded-[12px] border border-line p-3">
                <p className="mb-1 text-[12px] text-muted">{t("pos.order", { no: o.orderNo })}</p>
                {o.items.map((i) => (
                  <div key={i.id} className="flex items-start gap-2 py-1 text-[14px]">
                    <span className="font-semibold">×{i.quantity}</span>
                    <span className="min-w-0 flex-1">
                      {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                      {i.note && <span className="block text-[12px] text-muted">{i.note}</span>}
                    </span>
                    <span className="text-[12px] font-semibold text-brand">
                      {t(`kitchenStatus.${i.kitchenStatus ?? "queued"}`)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {canOrder && (
              <button
                type="button"
                onClick={() => setView("menu")}
                className="h-12 w-full rounded-[12px] bg-ink text-[15px] font-semibold text-white"
              >
                {t("guest.orderMore")}
              </button>
            )}
          </section>
        )}
      </main>

      {canOrder && view === "menu" && count > 0 && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-[480px] p-4">
          <button
            type="button"
            onClick={() => setView("cart")}
            className="flex h-14 w-full items-center justify-between rounded-[14px] bg-ink px-5 text-[16px] font-semibold text-white"
          >
            <span>{t("guest.viewOrder", { count })}</span>
            <span>{formatYen(total, locale)}</span>
          </button>
        </div>
      )}
    </div>
  );
}
