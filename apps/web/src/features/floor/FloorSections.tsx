"use client";
/**
 * Floor dashboard building blocks: ready-to-serve task cards (grouped by table, one action per real item), the
 * preparing list (secondary) and compact active tables (tertiary). Theme tokens only.
 */
import type { FloorItemDto, FloorTableServiceDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";
import { pickSnapshotName } from "../../lib/format";

export interface TableGroup {
  tableSessionId: string;
  tableName: string;
  items: FloorItemDto[];
  /** Oldest time in the group (ready time for ready food, order time for preparing food). */
  since: number;
}

/** Groups items by table, oldest first; items inside keep their own identity (never merged). */
export function groupByTable(items: readonly FloorItemDto[], field: "readyAt" | "orderedAt") {
  const map = new Map<string, TableGroup>();
  for (const i of items) {
    const at = new Date(i[field] ?? i.orderedAt).getTime();
    const g = map.get(i.tableSessionId) ?? {
      tableSessionId: i.tableSessionId,
      tableName: i.tableName,
      items: [],
      since: at,
    };
    g.items.push(i);
    g.since = Math.min(g.since, at);
    map.set(i.tableSessionId, g);
  }
  return [...map.values()].sort((a, b) => a.since - b.since);
}

export const minutesBetween = (fromMs: number, nowMs: number) =>
  Math.max(0, Math.floor((nowMs - fromMs) / 60_000));

/** Food waiting this long is highlighted (it is getting cold). */
const LATE_MINUTES = 8;

// ---------------------------------------------------------------- summary

export function SummaryStat({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number | null;
  tone: "brand" | "light";
  href: string;
}) {
  const strong = tone === "brand" && (value ?? 0) > 0;
  return (
    <a
      href={href}
      className={`flex min-w-0 flex-1 flex-col gap-1 rounded-[14px] px-3 py-2.5 transition-colors sm:px-3.5 ${strong ? "bg-brand text-white hover:bg-brand-dark" : "bg-white/10 text-white hover:bg-white/15"}`}
    >
      <span className="text-[11px] leading-tight font-semibold opacity-85 sm:text-[13px]">
        {label}
      </span>
      <span className="text-[24px] leading-none font-bold tabular-nums sm:text-[28px]">
        {value ?? "–"}
      </span>
    </a>
  );
}

// ---------------------------------------------------------------- ready to serve

export function ReadyTaskCard({
  group,
  stillCooking,
  now,
  meId,
  assignedToMe,
  canServe,
  busy,
  fresh,
  onPickUp,
  onServe,
}: {
  group: TableGroup;
  /** The same table's items that are NOT ready yet (shown so nobody serves a half order by mistake). */
  stillCooking: FloorItemDto[];
  now: number;
  meId: string;
  assignedToMe: boolean;
  canServe: boolean;
  busy: boolean;
  /** Just arrived since the previous refresh: highlighted briefly. */
  fresh: boolean;
  onPickUp: (ids: string[]) => void;
  onServe: (ids: string[]) => void;
}) {
  const t = useTranslations("floor");
  const locale = useLocale();
  const waited = minutesBetween(group.since, now);
  const late = waited >= LATE_MINUTES;
  const orderNos = [...new Set(group.items.map((i) => i.orderNo))];
  const notPicked = group.items.filter((i) => !i.pickedUp).map((i) => i.kitchenItemId);
  const all = group.items.map((i) => i.kitchenItemId);
  const portions = group.items.reduce((n, i) => n + i.quantity, 0);

  return (
    <article
      aria-labelledby={`rt-${group.tableSessionId}`}
      aria-busy={busy}
      className={`overflow-hidden rounded-[18px] bg-white shadow-sm ring-1 transition-shadow ${fresh ? "shadow-lg shadow-brand/20 ring-2 ring-brand" : late ? "ring-brand/40" : "ring-line"}`}
    >
      <header className="flex items-start gap-3 border-b border-line-soft px-4 pt-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id={`rt-${group.tableSessionId}`}
              className="text-[26px] leading-none font-bold tracking-tight"
            >
              {group.tableName}
            </h3>
            {assignedToMe && (
              <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold text-white">
                {t("yourTable")}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[12px] text-muted">
            {orderNos.map((n) => t("orderRef", { no: n })).join(" · ")}
            {" · "}
            {t("portions", { count: portions })}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums ${late ? "bg-brand text-white" : "bg-brand-tint text-brand-dark"}`}
        >
          {waited === 0 ? t("readyJustNow") : t("readyFor", { minutes: waited })}
        </span>
      </header>

      <ul className="divide-y divide-line-soft">
        {group.items.map((i) => (
          <li
            key={i.kitchenItemId}
            className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3"
          >
            <span className="w-8 shrink-0 pt-0.5 text-[17px] font-bold tabular-nums">
              ×{i.quantity}
            </span>
            <div className="min-w-[min(100%,140px)] flex-1">
              <p className="text-[16px] leading-snug font-semibold break-words">
                {pickSnapshotName(i.nameJa, i.nameEn, locale)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {i.note && (
                  <span className="rounded-[6px] bg-brand-tint px-1.5 py-0.5 text-[12px] font-bold break-words text-brand-dark">
                    {i.note}
                  </span>
                )}
                {orderNos.length > 1 && (
                  <span className="text-[11px] text-muted">{t("orderRef", { no: i.orderNo })}</span>
                )}
                {i.pickedUp && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-bold text-ok">
                    <span aria-hidden className="size-1.5 rounded-full bg-current" />
                    {i.pickedUp.byUserId === meId
                      ? t("pickedUpByYou")
                      : t("pickedUpBy", { name: i.pickedUp.byName })}
                  </span>
                )}
              </div>
            </div>
            {canServe && (
              <div className="ml-auto flex shrink-0 gap-2">
                {!i.pickedUp && (
                  <ActionButton
                    variant="outline"
                    disabled={busy}
                    onClick={() => onPickUp([i.kitchenItemId])}
                    label={t("pickUp")}
                    aria={t("pickUpNamed", { name: pickSnapshotName(i.nameJa, i.nameEn, locale) })}
                  />
                )}
                <ActionButton
                  variant="dark"
                  disabled={busy}
                  onClick={() => onServe([i.kitchenItemId])}
                  label={t("served")}
                  aria={t("servedNamed", { name: pickSnapshotName(i.nameJa, i.nameEn, locale) })}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      {stillCooking.length > 0 && (
        <p className="border-t border-line-soft bg-panel px-4 py-2.5 text-[12px] text-ink-2">
          <span className="font-bold">{t("stillInKitchen")}</span>{" "}
          {stillCooking
            .map((i) => `${pickSnapshotName(i.nameJa, i.nameEn, locale)} ×${String(i.quantity)}`)
            .join("、")}
        </p>
      )}

      {canServe && group.items.length > 1 && (
        <footer className="flex gap-2 border-t border-line-soft px-4 py-3">
          {notPicked.length > 0 && (
            <ActionButton
              variant="outline"
              wide
              disabled={busy}
              onClick={() => onPickUp(notPicked)}
              label={t("pickUpAll", { count: notPicked.length })}
            />
          )}
          <ActionButton
            variant="brand"
            wide
            disabled={busy}
            onClick={() => onServe(all)}
            label={t("serveAll", { count: all.length })}
          />
        </footer>
      )}
    </article>
  );
}

function ActionButton({
  variant,
  label,
  aria,
  onClick,
  disabled,
  wide = false,
}: {
  variant: "outline" | "dark" | "brand";
  label: string;
  aria?: string;
  onClick: () => void;
  disabled: boolean;
  wide?: boolean;
}) {
  const styles = {
    outline: "bg-white text-ink ring-1 ring-line hover:bg-chip",
    dark: "bg-ink text-white hover:bg-black",
    brand: "bg-brand text-white hover:bg-brand-dark",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={aria}
      className={`h-11 rounded-[12px] px-4 text-[14px] font-bold whitespace-nowrap transition-[background-color,transform] active:scale-[0.97] disabled:cursor-wait disabled:opacity-50 ${wide ? "flex-1" : "min-w-[88px]"} ${styles[variant]}`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------- preparing (secondary)

export function PreparingList({ groups, now }: { groups: TableGroup[]; now: number }) {
  const t = useTranslations("floor");
  const locale = useLocale();
  return (
    <ul className="divide-y divide-line-soft">
      {groups.map((g) => (
        <li key={g.tableSessionId} className="flex gap-3 px-4 py-3">
          <span className="w-12 shrink-0 text-[17px] font-bold">{g.tableName}</span>
          <div className="min-w-0 flex-1 space-y-1">
            {g.items.map((i) => (
              <p key={i.kitchenItemId} className="flex items-start gap-2 text-[14px]">
                <span className="min-w-0 flex-1 break-words">
                  {pickSnapshotName(i.nameJa, i.nameEn, locale)}{" "}
                  <span className="font-bold tabular-nums">×{i.quantity}</span>
                  {i.note && <span className="ml-1 text-[12px] text-muted">({i.note})</span>}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${i.status === "preparing" ? "bg-chip text-ink-2" : "text-muted ring-1 ring-line"}`}
                >
                  {t(`status_${i.status}`)}
                </span>
              </p>
            ))}
          </div>
          <span className="shrink-0 text-[12px] text-muted tabular-nums">
            {t("orderedAgo", { minutes: minutesBetween(g.since, now) })}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- active tables (tertiary)

export function ActiveTablesGrid({
  tables,
  meId,
  canOpenOrder,
}: {
  tables: FloorTableServiceDto[];
  meId: string;
  canOpenOrder: boolean;
}) {
  const t = useTranslations("floor");
  return (
    <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-2 2xl:grid-cols-3">
      {tables.map((x) => {
        const body: ReactNode = (
          <>
            <div className="flex items-start justify-between gap-2">
              <span className="text-[19px] leading-tight font-bold">{x.tableName}</span>
              <span className="text-[12px] font-semibold text-muted tabular-nums">
                {t("guests", { count: x.guestCount })}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {x.readyCount > 0 && (
                <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-white">
                  {t("chipReady", { count: x.readyCount })}
                </span>
              )}
              {x.preparingCount > 0 && (
                <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-bold text-ink-2">
                  {t("chipCooking", { count: x.preparingCount })}
                </span>
              )}
              {x.readyCount === 0 && x.preparingCount === 0 && (
                <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-line">
                  {x.servedCount > 0 ? t("chipAllServed") : t("chipNoOrders")}
                </span>
              )}
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              {x.status === "bill_requested" ? t("billRequested") : t("dining")}
              {x.assignedWaiterId === meId && <span className="text-ink">· {t("yourTable")}</span>}
            </p>
          </>
        );
        const cls = `block h-full rounded-[14px] bg-white p-3 ring-1 transition-[box-shadow,transform] ${x.readyCount > 0 ? "ring-brand/50" : "ring-line"}`;
        return (
          <li key={x.tableSessionId}>
            {canOpenOrder ? (
              <Link
                href={`/pos/${x.tableSessionId}`}
                aria-label={t("openTable", { table: x.tableName })}
                className={`${cls} hover:-translate-y-0.5 hover:shadow-md hover:shadow-ink/10`}
              >
                {body}
              </Link>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- section chrome

export function Section({
  id,
  title,
  count,
  tone = "plain",
  children,
}: {
  id: string;
  title: string;
  count: number | null;
  tone?: "primary" | "plain";
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-[150px]">
      <h2
        id={`${id}-h`}
        className={`mb-2.5 flex items-center gap-2 font-bold ${tone === "primary" ? "text-[19px]" : "text-[16px] text-ink-2"}`}
      >
        {title}
        {count !== null && (
          <span
            className={`rounded-full px-2 py-0.5 text-[12px] tabular-nums ${tone === "primary" && count > 0 ? "bg-brand text-white" : "bg-chip text-ink-2"}`}
          >
            {count}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

export function EmptyNote({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-[16px] bg-white px-4 py-6 text-center ring-1 ring-line-soft">
      <p className="text-[15px] font-bold text-ink-2">{title}</p>
      {hint && <p className="mt-1 text-[13px] text-muted">{hint}</p>}
    </div>
  );
}
