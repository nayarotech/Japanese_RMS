"use client";
/**
 * Floor: the waiter's live service dashboard (moving prepared food from the kitchen to the table).
 * Tables (occupancy, POS, bill, checkout) and Kitchen (preparation) stay on their own pages; Floor reads the SAME
 * kitchen items and dining sessions through GET /floor/board and changes them only through the floor actions
 * (pickup acknowledgement, serve). Socket events trigger a refetch; PostgreSQL is the source of truth.
 */
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LangToggle } from "../../../components/LangToggle";
import {
  ActiveTablesGrid,
  EmptyNote,
  PreparingList,
  ReadyTaskCard,
  Section,
  SummaryStat,
  groupByTable,
} from "../../../features/floor/FloorSections";
import { type ReadyAlert, useFloorBoard } from "../../../features/floor/useFloorBoard";
import { useStaff } from "../../../features/staff/StaffProvider";
import { ApiError, errorKey } from "../../../lib/api";
import { pickSnapshotName } from "../../../lib/format";

const VIBRATE_KEY = "rp_floor_vibrate";

function actionErrorKey(err: ApiError): string {
  switch (err.code) {
    case "invalid_kitchen_transition":
      return "floor.errors.alreadyHandled";
    case "already_picked_up":
      return "floor.errors.alreadyPickedUp";
    case "session_closed":
      return "floor.errors.sessionClosed";
    case "not_found":
      return "floor.errors.gone";
    default:
      return errorKey(err);
  }
}

export default function FloorPage() {
  const t = useTranslations();
  const tf = useTranslations("floor");
  const locale = useLocale();
  const { me, can } = useStaff();
  const canServe = can("floor.serve");
  const [alerts, setAlerts] = useState<ReadyAlert[]>([]);
  const [notice, setNotice] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [vibrate, setVibrate] = useState(false);
  const [tick, setTick] = useState(0);
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      setVibrate(localStorage.getItem(VIBRATE_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const onAlert = useCallback(
    (a: ReadyAlert) => {
      // One alert per table: items the kitchen finishes one by one are merged, never stacked.
      setAlerts((cur) => {
        const same = cur.find((x) => x.tableName === a.tableName);
        const merged = same ? { ...a, items: [...same.items, ...a.items].slice(0, 8) } : a;
        return [merged, ...cur.filter((x) => x.tableName !== a.tableName)].slice(0, 2);
      });
      // Vibration only when the user turned it on (and the device supports it). No permission prompts.
      if (vibrate && typeof navigator.vibrate === "function") navigator.vibrate([120, 80, 120]);
    },
    [vibrate],
  );
  const { board, loadError, connected, now, pickUp, serve } = useFloorBoard(onAlert);

  // Alerts fade out on their own; the task cards remain until the food is served.
  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = setTimeout(() => setAlerts((cur) => cur.slice(0, -1)), 12_000);
    return () => clearTimeout(timer);
  }, [alerts]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);
  // Re-render waiting times every 30 s.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Highlight tables whose ready food appeared since the previous refresh.
  useEffect(() => {
    if (!board) return undefined;
    const ids = new Set(board.ready.map((i) => i.kitchenItemId));
    const previous = known.current;
    known.current = ids;
    if (!previous) return undefined;
    const added = board.ready.filter((i) => !previous.has(i.kitchenItemId));
    if (added.length === 0) return undefined;
    setFresh(new Set(added.map((i) => i.tableSessionId)));
    const timer = setTimeout(() => setFresh(new Set()), 5_000);
    return () => clearTimeout(timer);
  }, [board]);

  // Server-clock "now", recomputed on every tick and every refresh.
  const nowMs = useMemo(() => now(), [now, tick, board]);
  const readyGroups = useMemo(() => groupByTable(board?.ready ?? [], "readyAt"), [board]);
  const preparingGroups = useMemo(() => groupByTable(board?.preparing ?? [], "orderedAt"), [board]);
  const assigned = useMemo(
    () => new Map((board?.tables ?? []).map((x) => [x.tableSessionId, x.assignedWaiterId])),
    [board],
  );

  async function run(group: string, fn: () => Promise<ApiError | null>, ok: string) {
    setBusy((b) => new Set(b).add(group));
    const err = await fn();
    setBusy((b) => {
      const next = new Set(b);
      next.delete(group);
      return next;
    });
    setNotice(err ? { tone: "error", text: t(actionErrorKey(err)) } : { tone: "ok", text: ok });
  }

  const toggleVibrate = () => {
    const next = !vibrate;
    setVibrate(next);
    try {
      localStorage.setItem(VIBRATE_KEY, next ? "1" : "0");
    } catch {
      /* optional */
    }
    if (next && typeof navigator.vibrate === "function") navigator.vibrate(60);
  };

  const counts = board?.counts ?? null;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 bg-ink text-white shadow-md shadow-ink/20">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 pt-3 lg:px-6">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-brand text-[18px] font-bold"
            aria-label={me.brand.displayName}
          >
            {me.brand.shortMark}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[18px] leading-tight font-bold">{tf("title")}</h1>
            <p className="truncate text-[12px] text-white/70">{me.user.displayName}</p>
          </div>
          <span
            role="status"
            className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-bold sm:inline-flex ${connected ? "bg-white/10 text-white" : "bg-brand text-white"}`}
          >
            <span
              aria-hidden
              className={`size-2 rounded-full ${connected ? "bg-ok" : "bg-white motion-safe:animate-pulse"}`}
            />
            {connected ? tf("live") : tf("reconnecting")}
          </span>
          <button
            type="button"
            onClick={toggleVibrate}
            aria-pressed={vibrate}
            className={`hidden h-10 rounded-full px-3 text-[12px] font-bold transition-colors md:block ${vibrate ? "bg-white text-ink" : "bg-white/10 text-white/80 hover:bg-white/15"}`}
          >
            {vibrate ? tf("vibrateOn") : tf("vibrateOff")}
          </button>
          <nav aria-label={t("nav.main")} className="flex items-center gap-1">
            {can("tables.view") && (
              <Link
                href="/tables"
                className="flex size-10 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
                aria-label={t("nav.tables")}
              >
                <span
                  aria-hidden
                  className="nav-icon size-[22px]"
                  style={{ maskImage: "url(/icons/tables.svg)" }}
                />
              </Link>
            )}
            {can("kitchen.view") && (
              <Link
                href="/kitchen"
                className="flex size-10 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
                aria-label={t("nav.kitchen")}
              >
                <span
                  aria-hidden
                  className="nav-icon size-[22px]"
                  style={{ maskImage: "url(/icons/kitchen.svg)" }}
                />
              </Link>
            )}
          </nav>
          <LangToggle dark compact />
        </div>
        <div className="mx-auto flex max-w-[1440px] gap-2 px-4 pt-3 pb-3 lg:px-6">
          <SummaryStat
            label={tf("statReady")}
            value={counts?.ready ?? null}
            tone="brand"
            href="#ready"
          />
          <SummaryStat
            label={tf("statPreparing")}
            value={counts?.preparing ?? null}
            tone="light"
            href="#preparing"
          />
          <SummaryStat
            label={tf("statTables")}
            value={counts?.activeTables ?? null}
            tone="light"
            href="#tables"
          />
        </div>
        {!connected && (
          <p className="bg-brand px-4 py-1.5 text-center text-[12px] font-semibold sm:hidden">
            {tf("reconnectingLong")}
          </p>
        )}
      </header>

      <div
        aria-live="assertive"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {alerts.map((a) => (
          <div
            key={a.id}
            role="alert"
            className="rp-sheet pointer-events-auto flex w-full max-w-[520px] items-start gap-3 rounded-[16px] bg-white px-4 py-3 shadow-xl shadow-ink/25 ring-2 ring-brand"
          >
            <span className="mt-0.5 rounded-[8px] bg-brand px-2 py-1 text-[15px] leading-none font-bold text-white">
              {a.tableName}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-bold">{tf("alertTitle", { table: a.tableName })}</p>
              <p className="truncate text-[13px] text-ink-2">
                {a.items
                  .map(
                    (i) => `${pickSnapshotName(i.nameJa, i.nameEn, locale)} ×${String(i.quantity)}`,
                  )
                  .join("、")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAlerts((cur) => cur.filter((x) => x.id !== a.id))}
              className="h-9 shrink-0 rounded-[10px] px-3 text-[13px] font-bold text-ink-2 hover:bg-chip"
            >
              {t("common.close")}
            </button>
          </div>
        ))}
      </div>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-4 lg:px-6 lg:py-6">
        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`mb-4 rounded-[12px] px-4 py-3 text-[14px] font-semibold ${notice.tone === "error" ? "bg-brand-tint text-brand-dark" : "bg-green-50 text-ok"}`}
          >
            {notice.text}
          </div>
        )}
        {loadError !== null && (
          <div
            role="alert"
            className="mb-4 rounded-[12px] bg-brand-tint px-4 py-3 text-[14px] font-semibold text-brand-dark"
          >
            {loadError instanceof ApiError && loadError.status === 403
              ? t(errorKey(loadError))
              : tf("loadFailed")}
          </div>
        )}

        {!board ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(340px,1fr)]" aria-busy>
            {[0, 1].map((k) => (
              <div key={k} className="space-y-3">
                {[0, 1].map((i) => (
                  <span key={i} className="rp-skeleton block h-40 rounded-[18px]" />
                ))}
              </div>
            ))}
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(340px,1fr)]">
            <Section id="ready" title={tf("readyTitle")} count={board.counts.ready} tone="primary">
              {readyGroups.length === 0 ? (
                <EmptyNote
                  title={tf("noReady")}
                  {...(board.counts.preparing > 0
                    ? { hint: tf("noReadyCooking", { count: board.counts.preparing }) }
                    : board.counts.activeTables > 0
                      ? { hint: tf("noReadyIdle") }
                      : {})}
                />
              ) : (
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  {readyGroups.map((g) => (
                    <ReadyTaskCard
                      key={g.tableSessionId}
                      group={g}
                      stillCooking={board.preparing.filter(
                        (i) => i.tableSessionId === g.tableSessionId,
                      )}
                      now={nowMs}
                      meId={me.user.id}
                      assignedToMe={assigned.get(g.tableSessionId) === me.user.id}
                      canServe={canServe}
                      busy={busy.has(g.tableSessionId)}
                      fresh={fresh.has(g.tableSessionId)}
                      onPickUp={(ids) =>
                        void run(
                          g.tableSessionId,
                          () => pickUp(ids),
                          tf("pickedUpOk", { table: g.tableName }),
                        )
                      }
                      onServe={(ids) =>
                        void run(
                          g.tableSessionId,
                          () => serve(ids),
                          tf("servedOk", { table: g.tableName }),
                        )
                      }
                    />
                  ))}
                </div>
              )}
              {!canServe && <p className="mt-2 text-[12px] text-muted">{tf("readOnly")}</p>}
            </Section>

            <div className="space-y-6">
              <Section id="preparing" title={tf("preparingTitle")} count={board.counts.preparing}>
                {preparingGroups.length === 0 ? (
                  <EmptyNote title={tf("noPreparing")} />
                ) : (
                  <div className="overflow-hidden rounded-[16px] bg-white ring-1 ring-line-soft">
                    <PreparingList groups={preparingGroups} now={nowMs} />
                  </div>
                )}
              </Section>
              <Section id="tables" title={tf("tablesTitle")} count={board.counts.activeTables}>
                {board.tables.length === 0 ? (
                  <EmptyNote title={tf("noTables")} hint={tf("noTablesHint")} />
                ) : (
                  <ActiveTablesGrid
                    tables={board.tables}
                    meId={me.user.id}
                    canOpenOrder={can("orders.create")}
                  />
                )}
              </Section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
