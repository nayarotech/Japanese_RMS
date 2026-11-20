"use client";
/**
 * Waiter / floor app (Figma "Waiter app (phone)"). Food-ready alerts arrive over the socket; the list
 * itself is always loaded from GET /floor/ready-items so nothing is lost if a notification is missed.
 */
import type { FloorTableDto, ReadyItemDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LangToggle } from "../../../components/LangToggle";
import { Banner, Spinner } from "../../../components/ui";
import { useStaff } from "../../../features/staff/StaffProvider";
import { errorKey, staffApi } from "../../../lib/api";
import { pickSnapshotName } from "../../../lib/format";
import { useRealtime } from "../../../lib/realtime";

export default function FloorPage() {
  const t = useTranslations();
  const locale = useLocale();
  const { me, can } = useStaff();
  const [ready, setReady] = useState<ReadyItemDto[] | null>(null);
  const [tables, setTables] = useState<FloorTableDto[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    staffApi
      .get<{ items: ReadyItemDto[] }>("/floor/ready-items")
      .then((r) => setReady(r.items))
      .catch((err: unknown) => setError(t(errorKey(err))));
    if (can("tables.view"))
      staffApi
        .get<{ tables: FloorTableDto[] }>("/floor/tables")
        .then((r) => setTables(r.tables))
        .catch(() => undefined);
  }, [t, can]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const { connected } = useRealtime(
    [
      "waiter.food.ready",
      "waiter.food.served",
      "kitchen.item.status_changed",
      "table.session.opened",
      "table.session.updated",
      "table.session.closed",
      "checkout.completed",
    ],
    (event, payload) => {
      if (event === "waiter.food.ready" && typeof payload["tableName"] === "string") {
        setFlash(t("floor.newAlert", { table: payload["tableName"] }));
        if (typeof navigator.vibrate === "function") navigator.vibrate(200);
      }
      load();
    },
  );

  const byTable = useMemo(() => {
    const groups = new Map<
      string,
      { tableName: string; ticketIds: Set<string>; items: ReadyItemDto[] }
    >();
    for (const i of ready ?? []) {
      const g = groups.get(i.tableSessionId) ?? {
        tableName: i.tableName,
        ticketIds: new Set<string>(),
        items: [],
      };
      g.items.push(i);
      g.ticketIds.add(i.ticketId);
      groups.set(i.tableSessionId, g);
    }
    return [...groups.entries()];
  }, [ready]);

  async function serve(path: string) {
    try {
      await staffApi.send("POST", path);
    } catch (err) {
      setError(t(errorKey(err)));
    }
    load();
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-canvas">
      <header className="flex items-center gap-3 bg-ink px-4 py-3.5 text-white">
        <span className="flex size-10 items-center justify-center rounded-[10px] bg-brand text-[18px] font-bold">
          {me.brand.shortMark}
        </span>
        <div className="min-w-0">
          <p className="text-[18px] font-bold">{t("floor.title")}</p>
          <p className="truncate text-[13px] text-white/70">{me.user.displayName}</p>
        </div>
        <div className="ml-auto">
          <LangToggle dark />
        </div>
      </header>
      {!connected && (
        <div className="bg-chip px-4 py-1.5 text-[12px] text-muted">{t("common.reconnecting")}</div>
      )}
      <main className="flex-1 space-y-4 p-4">
        {flash && (
          <div aria-live="assertive">
            <Banner tone="info">{flash}</Banner>
          </div>
        )}
        {error && <Banner>{error}</Banner>}
        <section aria-label={t("floor.alerts")}>
          <h2 className="mb-2 text-[14px] font-semibold text-muted">{t("floor.alerts")}</h2>
          {!ready ? (
            <Spinner label={t("common.loading")} />
          ) : byTable.length === 0 ? (
            <p className="rounded-[12px] bg-white p-4 text-[14px] text-muted">
              {t("floor.noAlerts")}
            </p>
          ) : (
            <ul className="space-y-3">
              {byTable.map(([sessionId, g]) => (
                <li key={sessionId} className="rounded-[14px] border-2 border-brand bg-white p-3.5">
                  <div className="flex items-center gap-3">
                    <span
                      className="flex size-10 items-center justify-center rounded-[10px] bg-brand-tint text-brand"
                      aria-hidden
                    >
                      🔔
                    </span>
                    <p className="flex-1 text-[16px] font-bold">
                      {t("floor.foodReady", { table: g.tableName })}
                    </p>
                    {can("floor.serve") && g.ticketIds.size === 1 && (
                      <button
                        type="button"
                        className="h-11 rounded-[10px] bg-brand px-4 text-[15px] font-semibold text-white"
                        onClick={() =>
                          void serve(`/floor/tickets/${[...g.ticketIds][0] ?? ""}/serve`)
                        }
                      >
                        {t("floor.serveAll")}
                      </button>
                    )}
                  </div>
                  <ul className="mt-2 divide-y divide-line">
                    {g.items.map((i) => (
                      <li
                        key={i.kitchenItemId}
                        className="flex items-center gap-2 py-2 text-[14px]"
                      >
                        <span className="font-semibold">×{i.quantity}</span>
                        <span className="min-w-0 flex-1">
                          {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                          {i.note && (
                            <span className="ml-1 rounded bg-brand-tint px-1.5 text-[11px] font-semibold text-brand">
                              {i.note}
                            </span>
                          )}
                        </span>
                        {can("floor.serve") && (
                          <button
                            type="button"
                            className="h-9 rounded-[8px] border border-line px-3 text-[13px] font-semibold"
                            onClick={() => void serve(`/floor/items/${i.kitchenItemId}/serve`)}
                          >
                            {t("floor.serve")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
        {tables.length > 0 && (
          <section aria-label={t("floor.tables")}>
            <h2 className="mb-2 text-[14px] font-semibold text-muted">{t("floor.tables")}</h2>
            <div className="grid grid-cols-2 gap-3">
              {tables.map((x) => {
                const readyHere = (x.session?.readyCount ?? 0) > 0;
                const style = readyHere
                  ? "bg-brand text-white border-brand"
                  : x.state === "bill_requested"
                    ? "bg-ink text-white border-ink"
                    : x.state === "occupied"
                      ? "bg-brand-tint border-[#f3c4c7]"
                      : "bg-white border-line text-ink-2";
                const label = readyHere
                  ? t("floor.foodReadyShort")
                  : x.state === "bill_requested"
                    ? t("floor.wantsBill")
                    : x.state === "occupied"
                      ? t("floor.dining")
                      : t("floor.free");
                const body = (
                  <>
                    <div className="flex items-start justify-between">
                      <span className="text-[20px] font-bold">{x.name}</span>
                      {x.session && (
                        <span className="text-[13px] font-semibold">
                          {t("floor.ppl", { count: x.session.guestCount })}
                        </span>
                      )}
                    </div>
                    <span className="mt-4 block text-[13px] font-medium">{label}</span>
                  </>
                );
                return x.session && can("orders.create") ? (
                  <Link
                    key={x.id}
                    href={`/pos/${x.session.id}`}
                    className={`rounded-[12px] border p-3.5 ${style}`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={x.id} className={`rounded-[12px] border p-3.5 ${style}`}>
                    {body}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
