"use client";
/**
 * Kitchen display. Orders arrive already "preparing" (the kitchen starts on receipt, no "new" step).
 * Two separate screens on the same page, switched with the tabs at the top (and linkable as #preparing / #ready):
 *   - Preparing: tickets still cooking; mark single dishes or the whole ticket ready.
 *   - Ready to serve: tickets whose every dish is ready, waiting for the floor (or online hand-over).
 * A ticket moves to "Ready to serve" only when all its dishes are ready (partial readiness is item-level).
 * Notes are rendered as plain text (React escapes them; never HTML).
 */
import type { KitchenTicketDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LangToggle } from "../../../components/LangToggle";
import { Spinner } from "../../../components/ui";
import { useStaff } from "../../../features/staff/StaffProvider";
import { errorKey, staffApi } from "../../../lib/api";
import { formatTime, minutesSince, pickSnapshotName } from "../../../lib/format";
import { useRealtime } from "../../../lib/realtime";

type View = "preparing" | "ready";

const SOURCE_STYLE: Record<KitchenTicketDto["source"], string> = {
  STAFF_POS: "bg-chip text-ink-2",
  TABLE_QR: "bg-brand-tint text-brand",
  ONLINE_PICKUP: "bg-chip text-ink-2",
  ONLINE_DELIVERY: "bg-ink text-white",
};

const viewFromHash = (): View =>
  typeof window !== "undefined" && window.location.hash === "#ready" ? "ready" : "preparing";

export default function KitchenPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { me, can } = useStaff();
  const [tickets, setTickets] = useState<KitchenTicketDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<View>("preparing");

  // The screen is linkable (#preparing / #ready) and follows the browser's back/forward buttons.
  useEffect(() => {
    const sync = () => setView(viewFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const show = (v: View) => {
    setView(v);
    window.history.replaceState(null, "", `#${v}`);
  };

  const load = useCallback(() => {
    staffApi
      .get<{ tickets: KitchenTicketDto[] }>("/kitchen/tickets")
      .then((r) => {
        setTickets(r.tickets);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(t(errorKey(err)));
      });
  }, [t]);
  useEffect(load, [load]);
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);
  const { connected } = useRealtime(
    [
      "kitchen.ticket.created",
      "kitchen.item.status_changed",
      "order.updated",
      "waiter.food.served",
    ],
    load,
  );

  async function act(path: string) {
    try {
      await staffApi.send("POST", path);
    } catch (err) {
      setError(t(errorKey(err)));
    }
    load();
  }

  // "new" only exists for tickets created before the kitchen-starts-on-receipt change: treat it as preparing.
  const preparing = (tickets ?? []).filter((x) => x.status === "preparing" || x.status === "new");
  const ready = (tickets ?? []).filter((x) => x.status === "ready");
  const list = view === "preparing" ? preparing : ready;

  return (
    <div className="flex h-dvh flex-col bg-ink text-white">
      <header className="flex h-[65px] shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:gap-4 sm:px-5">
        <Link
          href="/tables"
          className="flex size-11 items-center justify-center rounded-[10px] bg-white/10"
          aria-label={t("common.back")}
        >
          ‹
        </Link>
        <span className="flex size-10 items-center justify-center rounded-[10px] bg-brand text-[18px] font-bold">
          {me.brand.shortMark}
        </span>
        <h1 className="text-[20px] font-bold whitespace-nowrap">{t("kitchen.title")}</h1>
        <span className="ml-auto hidden text-[13px] text-white/70 lg:block">
          {t("kitchen.hint")}
        </span>
        <span className="ml-auto text-[18px] font-bold tabular-nums sm:text-[22px] lg:ml-0">
          {formatTime(new Date(now), locale, me.location.timeZone)}
        </span>
        <LangToggle dark />
      </header>

      <nav
        role="tablist"
        aria-label={t("kitchen.screens")}
        className="grid shrink-0 grid-cols-2 gap-2 border-b border-white/10 px-5 py-3"
      >
        {(
          [
            { key: "preparing", label: t("kitchen.preparing"), count: preparing.length },
            { key: "ready", label: t("kitchen.ready"), count: ready.length },
          ] as const
        ).map((tab) => {
          const active = view === tab.key;
          return (
            <a
              key={tab.key}
              href={`#${tab.key}`}
              role="tab"
              aria-selected={active}
              aria-controls="kitchen-screen"
              onClick={(e) => {
                e.preventDefault();
                show(tab.key);
              }}
              className={`flex h-14 items-center justify-center gap-3 rounded-[12px] text-[17px] font-bold transition-colors ${active ? "bg-white text-ink" : "bg-white/10 text-white/80 hover:bg-white/15"}`}
            >
              <span
                aria-hidden
                className={`size-2.5 rounded-full ${tab.key === "preparing" ? "bg-brand" : "bg-ok"}`}
              />
              {tab.label}
              <span
                className={`min-w-8 rounded-full px-2 py-0.5 text-[15px] tabular-nums ${active ? (tab.key === "ready" && tab.count > 0 ? "bg-brand text-white" : "bg-ink text-white") : "bg-white/15"}`}
              >
                {tab.count}
              </span>
            </a>
          );
        })}
      </nav>

      {(!connected || error) && (
        <div className="bg-white/10 px-5 py-1.5 text-[12px] text-white/80">
          {error ?? t("common.reconnecting")}
        </div>
      )}

      {!tickets ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <section
          id="kitchen-screen"
          role="tabpanel"
          aria-label={view === "preparing" ? t("kitchen.preparing") : t("kitchen.ready")}
          className="min-h-0 flex-1 overflow-y-auto p-5"
        >
          {list.length === 0 ? (
            <p className="py-16 text-center text-[16px] text-white/50">
              {view === "preparing" ? t("kitchen.emptyPreparing") : t("kitchen.emptyReady")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {list.map((ticket) => (
                <article
                  key={ticket.id}
                  className="flex flex-col overflow-hidden rounded-[12px] bg-white text-ink"
                >
                  <div
                    className={`flex items-center justify-between px-3.5 py-2.5 ${ticket.status === "ready" ? "bg-ok text-white" : "bg-chip"}`}
                  >
                    <span className="text-[20px] font-bold">
                      {ticket.tableName ?? `#${String(ticket.orderNo).padStart(4, "0")}`}
                    </span>
                    <span className="text-[14px] font-semibold">
                      {t("common.minutes", { count: minutesSince(ticket.createdAt, now) })}
                    </span>
                  </div>
                  <div className="flex-1 px-3.5 pt-2">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                      <span
                        className={`rounded px-1.5 py-0.5 font-semibold ${SOURCE_STYLE[ticket.source]}`}
                      >
                        {t(`source.${ticket.source}`)}
                      </span>
                      <span>{formatTime(ticket.createdAt, locale, me.location.timeZone)}</span>
                      {ticket.dueAt && (
                        <span className="font-semibold text-ink">
                          {t("kitchen.due", {
                            time: formatTime(ticket.dueAt, locale, me.location.timeZone),
                          })}
                        </span>
                      )}
                    </div>
                    <ul>
                      {ticket.items
                        .filter((i) => i.status !== "voided")
                        .map((i) => {
                          const cooking = i.status === "preparing" || i.status === "queued";
                          return (
                            <li
                              key={i.id}
                              className="flex items-start gap-3 border-b border-line py-2.5 last:border-b-0"
                            >
                              <span className="w-7 text-[16px] font-bold">×{i.quantity}</span>
                              <div className="min-w-0 flex-1">
                                <p
                                  className={`text-[16px] font-medium ${view === "preparing" && !cooking ? "text-muted" : ""}`}
                                >
                                  {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                                </p>
                                {i.note && (
                                  <p className="mt-0.5 inline-block rounded bg-brand-tint px-1.5 text-[12px] font-semibold text-brand">
                                    {i.note}
                                  </p>
                                )}
                              </div>
                              {can("kitchen.update") && i.status === "preparing" && (
                                <button
                                  type="button"
                                  onClick={() => void act(`/kitchen/items/${i.id}/ready`)}
                                  className="h-10 rounded-[8px] border border-brand px-3 text-[13px] font-semibold text-brand hover:bg-brand-tint"
                                >
                                  {t("kitchen.itemReady")}
                                </button>
                              )}
                              {!cooking && (
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${i.status === "ready" ? "bg-green-50 text-ok" : "bg-chip text-muted"}`}
                                >
                                  {t(`kitchenStatus.${i.status}`)}
                                </span>
                              )}
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                  {can("kitchen.update") &&
                    view === "preparing" &&
                    ticket.items.some((i) => i.status === "preparing") && (
                      <button
                        type="button"
                        onClick={() => void act(`/kitchen/tickets/${ticket.id}/ready`)}
                        className="mt-2 h-14 w-full bg-brand text-[16px] font-semibold text-white hover:bg-brand-dark"
                      >
                        {t("kitchen.markReady")}
                      </button>
                    )}
                  {view === "ready" && ticket.tableSessionId === null && (
                    <p className="mt-2 h-12 w-full bg-panel px-3 text-center text-[14px] leading-[48px] font-semibold text-muted">
                      {t("kitchen.awaitingHandover")}
                    </p>
                  )}
                  {view === "ready" && ticket.tableSessionId !== null && can("floor.serve") && (
                    <button
                      type="button"
                      onClick={() => void act(`/floor/tickets/${ticket.id}/serve`)}
                      className="mt-2 h-12 w-full bg-ink text-[15px] font-semibold text-white"
                    >
                      {t("kitchen.served")}
                    </button>
                  )}
                  {view === "ready" && ticket.tableSessionId !== null && !can("floor.serve") && (
                    <p className="mt-2 h-12 w-full bg-panel px-3 text-center text-[14px] leading-[48px] font-semibold text-muted">
                      {t("kitchen.awaitingFloor")}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
