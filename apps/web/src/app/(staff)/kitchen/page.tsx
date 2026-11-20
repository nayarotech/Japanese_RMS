"use client";
/**
 * Kitchen display (Figma "Kitchen display"). Item-level status: a ticket moves to "Ready to serve" only
 * when every item is ready. Notes are rendered as plain text (React escapes them; never HTML).
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

export default function KitchenPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { me, can } = useStaff();
  const [tickets, setTickets] = useState<KitchenTicketDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  const columns = [
    {
      key: "new",
      title: t("kitchen.new"),
      dot: "bg-white",
      list: (tickets ?? []).filter((x) => x.status === "new"),
    },
    {
      key: "preparing",
      title: t("kitchen.preparing"),
      dot: "bg-brand",
      list: (tickets ?? []).filter((x) => x.status === "preparing"),
    },
    {
      key: "ready",
      title: t("kitchen.ready"),
      dot: "bg-placeholder",
      list: (tickets ?? []).filter((x) => x.status === "ready"),
    },
  ] as const;

  return (
    <div className="flex h-dvh flex-col bg-ink text-white">
      <header className="flex h-[65px] shrink-0 items-center gap-4 border-b border-white/10 px-5">
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
        <h1 className="text-[20px] font-bold">{t("kitchen.title")}</h1>
        <span className="text-[13px] text-white/60">{t("kitchen.allStations")}</span>
        <span className="ml-auto hidden text-[13px] text-white/70 lg:block">
          {t("kitchen.hint")}
        </span>
        <span className="text-[22px] font-bold tabular-nums">
          {formatTime(new Date(now), locale, me.location.timeZone)}
        </span>
        <LangToggle dark />
      </header>
      {(!connected || error) && (
        <div className="bg-white/10 px-5 py-1.5 text-[12px] text-white/80">
          {error ?? t("common.reconnecting")}
        </div>
      )}
      {!tickets ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-3 md:overflow-visible">
          {columns.map((col) => (
            <section key={col.key} className="flex min-h-0 flex-col" aria-label={col.title}>
              <h2 className="mb-3 flex items-center gap-2 text-[16px] font-semibold">
                <span className={`size-2.5 rounded-full ${col.dot}`} />
                {col.title}
                <span className="rounded-full bg-white/10 px-2 text-[13px]">{col.list.length}</span>
              </h2>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                {col.list.length === 0 && (
                  <p className="text-[14px] text-white/40">{t("kitchen.empty")}</p>
                )}
                {col.list.map((ticket) => (
                  <article
                    key={ticket.id}
                    className="overflow-hidden rounded-[12px] bg-white text-ink"
                  >
                    <div
                      className={`flex items-center justify-between px-3.5 py-2.5 ${ticket.status === "ready" ? "bg-brand text-white" : "bg-chip"}`}
                    >
                      <span className="text-[20px] font-bold">{ticket.tableName}</span>
                      <span className="text-[14px] font-semibold">
                        {t("common.minutes", { count: minutesSince(ticket.createdAt, now) })}
                      </span>
                    </div>
                    <div className="px-3.5 pt-2">
                      <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
                        <span
                          className={`rounded px-1.5 py-0.5 font-semibold ${ticket.source === "TABLE_QR" ? "bg-brand-tint text-brand" : "bg-chip text-ink-2"}`}
                        >
                          {t(`source.${ticket.source}`)}
                        </span>
                        <span>{formatTime(ticket.createdAt, locale, me.location.timeZone)}</span>
                      </div>
                      <ul>
                        {ticket.items
                          .filter((i) => i.status !== "voided")
                          .map((i) => (
                            <li
                              key={i.id}
                              className="flex items-start gap-3 border-b border-line py-2.5"
                            >
                              <span className="w-7 text-[16px] font-bold">×{i.quantity}</span>
                              <div className="min-w-0 flex-1">
                                <p
                                  className={`text-[16px] font-medium ${i.status === "ready" || i.status === "served" ? "text-muted line-through" : ""}`}
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
                                  className="rounded-[8px] border border-brand px-2.5 py-1 text-[12px] font-semibold text-brand"
                                >
                                  {t("kitchen.itemReady")}
                                </button>
                              )}
                              {i.status !== "preparing" && (
                                <span className="text-[11px] text-muted">
                                  {t(`kitchenStatus.${i.status}`)}
                                </span>
                              )}
                            </li>
                          ))}
                      </ul>
                    </div>
                    {can("kitchen.update") && ticket.status === "new" && (
                      <button
                        type="button"
                        onClick={() => void act(`/kitchen/tickets/${ticket.id}/start`)}
                        className="h-14 w-full bg-ink text-[16px] font-semibold text-white"
                      >
                        {t("kitchen.startCooking")}
                      </button>
                    )}
                    {can("kitchen.update") &&
                      ticket.status === "preparing" &&
                      ticket.items.some((i) => i.status === "queued") && (
                        <button
                          type="button"
                          onClick={() => void act(`/kitchen/tickets/${ticket.id}/start`)}
                          className="h-12 w-full bg-ink text-[15px] font-semibold text-white"
                        >
                          {t("kitchen.startCooking")}
                        </button>
                      )}
                    {can("kitchen.update") &&
                      ticket.status === "preparing" &&
                      ticket.items.some((i) => i.status === "preparing") && (
                        <button
                          type="button"
                          onClick={() => void act(`/kitchen/tickets/${ticket.id}/ready`)}
                          className="h-14 w-full bg-brand text-[16px] font-semibold text-white"
                        >
                          {t("kitchen.markReady")}
                        </button>
                      )}
                    {can("floor.serve") && ticket.status === "ready" && (
                      <button
                        type="button"
                        onClick={() => void act(`/floor/tickets/${ticket.id}/serve`)}
                        className="h-12 w-full bg-white text-[15px] font-semibold text-ink"
                      >
                        {t("kitchen.served")}
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
