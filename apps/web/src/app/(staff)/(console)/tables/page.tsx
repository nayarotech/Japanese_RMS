"use client";
/** Table map (Figma "Tables (cashier)"): occupancy is DERIVED from active dining sessions on the server. */
import type { FloorTableDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LangToggle } from "../../../../components/LangToggle";
import { PageHeader } from "../../../../components/PageHeader";
import {
  Badge,
  Banner,
  Button,
  ConfirmButton,
  Dialog,
  Spinner,
  Stepper,
} from "../../../../components/ui";
import { useStaff } from "../../../../features/staff/StaffProvider";
import { errorKey, staffApi } from "../../../../lib/api";
import { formatTime, formatYen, minutesSince } from "../../../../lib/format";
import { useRealtime } from "../../../../lib/realtime";

export default function TablesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { me, can } = useStaff();
  const [tables, setTables] = useState<FloorTableDto[] | null>(null);
  const [area, setArea] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seatFor, setSeatFor] = useState<FloorTableDto | null>(null);
  const [guests, setGuests] = useState(2);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    staffApi
      .get<{ tables: FloorTableDto[] }>("/floor/tables")
      .then((r) => {
        setTables(r.tables);
      })
      .catch((err: unknown) => {
        setError(t(errorKey(err)));
      });
  }, [t]);
  useEffect(load, [load]);
  const { connected } = useRealtime(
    [
      "table.session.opened",
      "table.session.updated",
      "table.session.closed",
      "order.created",
      "order.updated",
      "kitchen.item.status_changed",
      "checkout.completed",
    ],
    load,
  );

  const areas = useMemo(
    () => [...new Set((tables ?? []).map((x) => x.area ?? "").filter(Boolean))],
    [tables],
  );
  const visible = (tables ?? []).filter((x) => area === "all" || x.area === area);
  const selected = tables?.find((x) => x.id === selectedId) ?? null;
  const activeSessionId = selected?.session?.id ?? "";
  const counts = { free: 0, occupied: 0, bill_requested: 0 };
  for (const x of tables ?? []) counts[x.state] += 1;

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(t(errorKey(err)));
      load();
    }
  }

  async function seat() {
    if (!seatFor) return;
    const table = seatFor;
    setSeatFor(null);
    await act(() => staffApi.send("POST", `/tables/${table.id}/sessions`, { guestCount: guests }));
    setSelectedId(table.id);
  }

  return (
    <>
      <PageHeader title={t("tables.title")} left={undefined}>
        <div
          role="tablist"
          className="mr-auto hidden items-center gap-1 rounded-[12px] bg-chip p-1 md:flex"
        >
          {["all", ...areas].map((a) => (
            <button
              key={a}
              role="tab"
              aria-selected={area === a}
              type="button"
              onClick={() => setArea(a)}
              className={`h-9 rounded-[9px] px-4 text-[13px] font-semibold ${area === a ? "bg-white text-ink shadow-sm" : "text-ink-2"}`}
            >
              {a === "all" ? t("tables.all") : a}
            </button>
          ))}
        </div>
        <Legend t={t} />
        <LangToggle />
      </PageHeader>
      {!connected && (
        <div className="no-print bg-chip px-6 py-1.5 text-[12px] text-muted">
          {t("common.reconnecting")}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-y-auto bg-canvas p-6">
          {error && (
            <div className="mb-4">
              <Banner>{error}</Banner>
            </div>
          )}
          {!tables ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((x) => (
                <TableCard
                  key={x.id}
                  table={x}
                  selected={x.id === selectedId}
                  locale={locale}
                  t={t}
                  onClick={() => setSelectedId(x.id)}
                />
              ))}
            </div>
          )}
        </section>
        <aside className="hidden w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line-2 bg-white p-5 lg:flex">
          <div className="grid grid-cols-3 gap-2">
            <Stat label={t("tables.free")} value={counts.free} className="bg-chip text-ink" />
            <Stat
              label={t("tables.occupied")}
              value={counts.occupied}
              className="bg-brand-tint text-brand"
            />
            <Stat
              label={t("tables.billRequested")}
              value={counts.bill_requested}
              className="bg-ink text-white"
            />
          </div>
          {!selected ? (
            <p className="text-[14px] text-muted">{t("tables.selectTable")}</p>
          ) : (
            <div className="space-y-3 rounded-[12px] border border-line p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[18px] font-bold">{selected.name}</h2>
                <StateBadge state={selected.state} t={t} />
              </div>
              {!selected.session ? (
                can("sessions.manage") && (
                  <Button
                    variant="dark"
                    className="h-14 w-full text-[16px]"
                    onClick={() => {
                      setGuests(Math.min(2, selected.capacity));
                      setSeatFor(selected);
                    }}
                  >
                    {t("tables.seatGuests")}
                  </Button>
                )
              ) : (
                <>
                  <dl className="space-y-2 text-[14px]">
                    <Row k={t("tables.guestCount")} v={String(selected.session.guestCount)} />
                    <Row
                      k={t("tables.seated")}
                      v={t("tables.elapsed", {
                        time: formatTime(selected.session.openedAt, locale, me.location.timeZone),
                        minutes: minutesSince(selected.session.openedAt),
                      })}
                    />
                    <Row
                      k={t("tables.slip")}
                      v={`#${String(selected.session.slipNo).padStart(4, "0")}`}
                    />
                    <Row k={t("tables.itemsOrdered")} v={String(selected.session.itemCount)} />
                  </dl>
                  <div className="flex items-center justify-between border-t border-line pt-3 text-[16px] font-bold">
                    <span>{t("tables.total")}</span>
                    <span>{formatYen(selected.session.subtotalYen, locale)}</span>
                  </div>
                  {can("orders.create") && selected.session.status === "open" && (
                    <Button
                      variant="dark"
                      className="h-14 w-full text-[16px]"
                      onClick={() => router.push(`/pos/${activeSessionId}`)}
                    >
                      {t("tables.addToOrder")}
                    </Button>
                  )}
                  <Button
                    className="h-12 w-full text-[15px]"
                    onClick={() => router.push(`/pos/${activeSessionId}?tab=submitted`)}
                  >
                    {t("tables.viewOrders")}
                  </Button>
                  {can("checkout.perform") && (
                    <Button
                      variant="brand"
                      className="h-14 w-full text-[16px]"
                      onClick={() => router.push(`/checkout/${activeSessionId}`)}
                    >
                      {t("tables.checkout")}
                    </Button>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {selected.session.status === "open" ? (
                      <Button
                        className="h-11 text-[13px]"
                        onClick={() =>
                          void act(() =>
                            staffApi.send("POST", `/sessions/${activeSessionId}/request-bill`),
                          )
                        }
                      >
                        {t("tables.requestBill")}
                      </Button>
                    ) : (
                      <Button
                        className="h-11 text-[13px]"
                        onClick={() =>
                          void act(() =>
                            staffApi.send("POST", `/sessions/${activeSessionId}/reopen`),
                          )
                        }
                      >
                        {t("tables.reopen")}
                      </Button>
                    )}
                    <ConfirmButton
                      className="h-11 text-[13px]"
                      label={t("tables.revokeGuests")}
                      message={t("tables.revokeGuestsConfirm")}
                      confirmLabel={t("common.confirm")}
                      cancelLabel={t("common.cancel")}
                      onConfirm={() =>
                        void act(() =>
                          staffApi.send("POST", `/sessions/${activeSessionId}/guests/revoke`),
                        )
                      }
                    />
                  </div>
                  {selected.session.itemCount === 0 && (
                    <Button
                      variant="ghost"
                      className="h-10 w-full text-[13px]"
                      onClick={() =>
                        void act(() => staffApi.send("POST", `/sessions/${activeSessionId}/close`))
                      }
                    >
                      {t("tables.closeEmpty")}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      {seatFor && (
        <Dialog
          title={`${seatFor.name} · ${t("tables.seatGuests")}`}
          onClose={() => setSeatFor(null)}
        >
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-medium">{t("tables.guestCount")}</span>
            <Stepper
              value={guests}
              min={1}
              max={99}
              onChange={setGuests}
              labels={{ dec: t("common.decrease"), inc: t("common.increase") }}
            />
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button className="h-12" onClick={() => setSeatFor(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="dark" className="h-12" onClick={() => void seat()}>
              {t("tables.open")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

type T = ReturnType<typeof useTranslations>;

function TableCard({
  table,
  selected,
  locale,
  t,
  onClick,
}: {
  table: FloorTableDto;
  selected: boolean;
  locale: string;
  t: T;
  onClick: () => void;
}) {
  const styles = {
    free: "bg-white border-line text-ink-2",
    occupied: "bg-brand-tint border-[#f3c4c7] text-ink",
    bill_requested: "bg-ink border-ink text-white",
  }[table.state];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex h-[150px] flex-col rounded-[12px] border p-4 text-left ${styles} ${selected ? "outline-2 outline-brand" : ""}`}
    >
      <div className="flex w-full items-start justify-between">
        <span className="text-[20px] font-bold">{table.name}</span>
        <StateBadge state={table.state} t={t} />
      </div>
      <span
        className={`text-[14px] ${table.state === "bill_requested" ? "text-white/80" : "text-muted"}`}
      >
        {t("common.seats", { count: table.capacity })}
      </span>
      {table.session && (
        <div className="mt-auto flex w-full items-end justify-between text-[15px] font-semibold">
          <span>{formatTime(table.session.openedAt, locale)}</span>
          {table.session.readyCount > 0 && (
            <Badge tone="light">
              {t("tables.readyCount", { count: table.session.readyCount })}
            </Badge>
          )}
          <span>{formatYen(table.session.subtotalYen, locale)}</span>
        </div>
      )}
    </button>
  );
}

function StateBadge({ state, t }: { state: FloorTableDto["state"]; t: T }) {
  if (state === "free") return <Badge>{t("tables.free")}</Badge>;
  if (state === "occupied") return <Badge tone="brand">{t("tables.occupied")}</Badge>;
  return <Badge tone="light">{t("tables.billRequested")}</Badge>;
}

function Legend({ t }: { t: T }) {
  return (
    <div className="hidden items-center gap-4 text-[13px] text-ink-2 xl:flex">
      <span className="flex items-center gap-1.5">
        <span className="size-3.5 rounded-[3px] border border-line bg-white" />
        {t("tables.free")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-3.5 rounded-[3px] border border-brand bg-brand-tint" />
        {t("tables.occupied")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-3.5 rounded-[3px] bg-ink" />
        {t("tables.billRequested")}
      </span>
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <div className={`rounded-[10px] p-3 ${className}`}>
      <p className="text-[12px]">{label}</p>
      <p className="text-[22px] font-bold">{value}</p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
