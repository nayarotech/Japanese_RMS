"use client";
/**
 * POS order entry (Figma "Order entry"). The cart holds menu ids, quantities and per-line notes only;
 * prices shown are previews. The server recalculates everything on submit.
 */
import type {
  MenuItemDto,
  SessionDetailResponse,
  StaffMenuResponse,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LangToggle } from "../../../../../components/LangToggle";
import { MenuItemImage } from "../../../../../components/MenuItemImage";
import { PageHeader } from "../../../../../components/PageHeader";
import {
  Badge,
  Banner,
  Button,
  ConfirmButton,
  Dialog,
  Spinner,
  Stepper,
} from "../../../../../components/ui";
import { useStaff } from "../../../../../features/staff/StaffProvider";
import { errorKey, newIdempotencyKey, staffApi } from "../../../../../lib/api";
import {
  formatTime,
  formatYen,
  pickName,
  pickSnapshotName,
  ratePercent,
} from "../../../../../lib/format";
import { useRealtime } from "../../../../../lib/realtime";

interface CartLine {
  key: string;
  item: MenuItemDto;
  quantity: number;
  note: string;
}

const MAX_NOTE = 140;

export default function PosPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { me, can } = useStaff();
  const [menu, setMenu] = useState<StaffMenuResponse | null>(null);
  const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const initialTab = useSearchParams().get("tab") === "submitted" ? "submitted" : "cart";
  const [tab, setTab] = useState<"cart" | "submitted">(initialTab);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; prepared: boolean } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  // One idempotency key per cart submission: retries after a network error never double-order.
  const submitKey = useRef<string>(newIdempotencyKey());

  const loadDetail = useCallback(() => {
    staffApi
      .get<SessionDetailResponse>(`/sessions/${sessionId}`)
      .then(setDetail)
      .catch((err: unknown) => {
        setMessage({ tone: "error", text: t(errorKey(err)) });
      });
  }, [sessionId, t]);

  useEffect(() => {
    staffApi
      .get<StaffMenuResponse>("/menu")
      .then(setMenu)
      .catch((err: unknown) => {
        setMessage({ tone: "error", text: t(errorKey(err)) });
      });
    loadDetail();
  }, [loadDetail, t]);
  useRealtime(
    [
      "order.created",
      "order.updated",
      "kitchen.item.status_changed",
      "table.session.updated",
      "table.session.closed",
      "checkout.completed",
    ],
    (_e, p) => {
      if (!p["tableSessionId"] || p["tableSessionId"] === sessionId) loadDetail();
    },
  );

  const items = useMemo(() => {
    const all = (menu?.categories ?? []).flatMap((c) => c.items.filter((i) => i.isActive));
    const q = query.trim().toLowerCase();
    return all.filter(
      (i) =>
        (category === "all" || i.categoryId === category) &&
        (!q ||
          i.name.ja.toLowerCase().includes(q) ||
          (i.name.en ?? "").toLowerCase().includes(q) ||
          (i.code ?? "").toLowerCase().includes(q)),
    );
  }, [menu, category, query]);

  const addItem = (item: MenuItemDto) => {
    if (!item.isAvailable) return;
    setCart((c) => {
      // Merge only into an existing line WITHOUT a note; lines with notes always stay separate.
      const plain = c.find((l) => l.item.id === item.id && l.note === "");
      if (plain)
        return c.map((l) => (l === plain ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l));
      return [...c, { key: crypto.randomUUID(), item, quantity: 1, note: "" }];
    });
    setTab("cart");
  };
  const updateLine = (key: string, patch: Partial<CartLine>) =>
    setCart((c) =>
      c.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0),
    );

  const previewTotal = cart.reduce((s, l) => s + l.item.priceYen * l.quantity, 0);
  const session = detail?.session;
  const canOrder = session?.status === "open" && can("orders.create");

  async function send() {
    if (cart.length === 0 || !canOrder) return;
    setBusy(true);
    setMessage(null);
    try {
      await staffApi.send(
        "POST",
        `/sessions/${sessionId}/orders`,
        {
          items: cart.map((l) => ({
            menuItemId: l.item.id,
            quantity: l.quantity,
            note: l.note.trim() || null,
          })),
        },
        { idempotencyKey: submitKey.current },
      );
      setCart([]);
      submitKey.current = newIdempotencyKey();
      setMessage({ tone: "ok", text: t("pos.sent") });
      setTab("submitted");
      loadDetail();
    } catch (err) {
      setMessage({ tone: "error", text: t(errorKey(err)) });
      loadDetail();
    } finally {
      setBusy(false);
    }
  }

  async function confirmVoid() {
    if (!voidTarget) return;
    const reason = voidReason.trim();
    if (voidTarget.prepared && !reason) return;
    const target = voidTarget;
    setVoidTarget(null);
    setVoidReason("");
    try {
      await staffApi.send("POST", `/order-items/${target.id}/void`, { reason: reason || null });
      loadDetail();
    } catch (err) {
      setMessage({ tone: "error", text: t(errorKey(err)) });
    }
  }

  if (!menu || !detail || !session) return <Spinner label={t("common.loading")} />;
  const bill = detail.bill;

  return (
    <>
      <PageHeader
        title={session.tableName}
        left={
          <Link
            href="/tables"
            className="flex size-10 items-center justify-center rounded-[10px] border border-line"
            aria-label={t("common.back")}
          >
            ‹
          </Link>
        }
      >
        <div className="mr-auto flex items-center gap-3">
          <Badge>{t("common.guests", { count: session.guestCount })}</Badge>
          <span className="text-[13px] text-muted">
            {t("pos.slipSeated", {
              slip: String(session.slipNo).padStart(4, "0"),
              time: formatTime(session.openedAt, locale, me.location.timeZone),
            })}
          </span>
        </div>
        <span className="hidden items-center gap-2 text-[13px] text-ink-2 md:flex">
          <span className="flex size-8 items-center justify-center rounded-full bg-ink text-[13px] font-semibold text-white">
            {me.user.displayName.slice(0, 1)}
          </span>
          {t("pos.server", { name: me.user.displayName })}
        </span>
        <LangToggle />
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col bg-canvas p-6">
          <label className="relative block">
            <span
              className="nav-icon absolute top-[14px] left-[14px] size-[18px] text-placeholder"
              style={{ maskImage: "url(/icons/search.svg)" }}
              aria-hidden
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pos.search")}
              aria-label={t("pos.search")}
              className="h-[46px] w-full rounded-[10px] border border-line bg-white pr-4 pl-[42px] text-[14px] placeholder:text-placeholder"
            />
          </label>
          <div className="mt-3.5 flex gap-2 overflow-x-auto pb-1">
            {[{ id: "all", name: { ja: t("pos.all"), en: t("pos.all") } }, ...menu.categories].map(
              (c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={category === c.id}
                  onClick={() => setCategory(c.id)}
                  className={`h-11 shrink-0 rounded-full border px-[18px] text-[14px] font-semibold ${category === c.id ? "border-ink bg-ink text-white" : "border-line bg-white text-ink-2"}`}
                >
                  {pickName(c.name, locale)}
                </button>
              ),
            )}
          </div>
          <div className="mt-3.5 grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto md:grid-cols-3 xl:grid-cols-4">
            {items.map((i) => (
              <button
                key={i.id}
                type="button"
                disabled={!i.isAvailable || !canOrder}
                onClick={() => addItem(i)}
                className="overflow-hidden rounded-[12px] border border-[#e1e4e7] bg-white text-left disabled:opacity-50"
              >
                <MenuItemImage
                  image={i.image}
                  name={pickName(i.name, locale)}
                  className="h-[76px] w-full"
                  letterClassName="text-[28px]"
                />
                <span className="block px-3 pt-2.5 text-[14px] font-medium">
                  {pickName(i.name, locale)}
                </span>
                <span className="block px-3 pb-3 text-[15px] font-bold">
                  {i.isAvailable ? formatYen(i.priceYen, locale) : t("pos.soldOut")}
                </span>
              </button>
            ))}
          </div>
        </section>

        <aside className="flex w-[381px] shrink-0 flex-col border-l border-line-2 bg-white">
          <div className="flex items-center gap-2 px-5 pt-5">
            <button
              type="button"
              onClick={() => setTab("cart")}
              aria-pressed={tab === "cart"}
              className={`text-[17px] font-bold ${tab === "cart" ? "text-ink" : "text-placeholder"}`}
            >
              {t("pos.currentOrder")}
            </button>
            <span className="text-[14px] font-medium text-muted">
              {t("common.items", { count: cart.reduce((s, l) => s + l.quantity, 0) })}
            </span>
            <button
              type="button"
              onClick={() => setTab("submitted")}
              aria-pressed={tab === "submitted"}
              className={`ml-auto text-[13px] font-semibold ${tab === "submitted" ? "text-ink" : "text-placeholder"}`}
            >
              {t("pos.submitted")} ({detail.orders.length})
            </button>
          </div>
          {session.status !== "open" && (
            <div className="px-5 pt-3">
              <Banner tone="info">
                {session.status === "closed"
                  ? t("pos.sessionClosed")
                  : t("pos.billRequestedPaused")}
              </Banner>
            </div>
          )}
          {message && (
            <div className="px-5 pt-3">
              <Banner tone={message.tone}>{message.text}</Banner>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            {tab === "cart" ? (
              cart.length === 0 ? (
                <p className="py-8 text-center text-[14px] text-muted">{t("pos.empty")}</p>
              ) : (
                cart.map((l) => (
                  <div key={l.key} className="border-b border-line-soft py-3">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">
                          {pickName(l.item.name, locale)}
                        </p>
                        <p className="text-[12px] text-muted">
                          {t("pos.unit", { price: formatYen(l.item.priceYen, locale) })}
                        </p>
                      </div>
                      <Stepper
                        value={l.quantity}
                        onChange={(q) => updateLine(l.key, { quantity: q })}
                        labels={{ dec: t("common.decrease"), inc: t("common.increase") }}
                      />
                      <span className="w-16 text-right text-[14px] font-semibold">
                        {formatYen(l.item.priceYen * l.quantity, locale)}
                      </span>
                    </div>
                    {noteOpen === l.key || l.note ? (
                      <input
                        autoFocus={noteOpen === l.key}
                        value={l.note}
                        maxLength={MAX_NOTE}
                        onChange={(e) => updateLine(l.key, { note: e.target.value })}
                        onBlur={() => setNoteOpen(null)}
                        placeholder={t("pos.notePlaceholder")}
                        aria-label={t("pos.notePlaceholder")}
                        className="mt-2 h-9 w-full rounded-[8px] border border-line bg-panel px-3 text-[13px]"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setNoteOpen(l.key)}
                        className="mt-1 text-[12px] font-semibold text-brand"
                      >
                        + {t("pos.addNote")}
                      </button>
                    )}
                  </div>
                ))
              )
            ) : detail.orders.length === 0 ? (
              <p className="py-8 text-center text-[14px] text-muted">{t("pos.noSubmitted")}</p>
            ) : (
              detail.orders.map((o) => (
                <div key={o.id} className="border-b border-line-soft py-3">
                  <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
                    <span className="font-semibold text-ink">
                      {t("pos.order", { no: o.orderNo })}
                    </span>
                    <Badge tone={o.source === "TABLE_QR" ? "brand" : "neutral"}>
                      {t(`source.${o.source}`)}
                    </Badge>
                    <span>{formatTime(o.createdAt, locale, me.location.timeZone)}</span>
                  </div>
                  {o.items.map((i) => (
                    <div
                      key={i.id}
                      className={`flex items-start gap-2 py-1 text-[13px] ${i.status === "voided" ? "text-placeholder line-through" : ""}`}
                    >
                      <span className="w-6 font-semibold">×{i.quantity}</span>
                      <span className="min-w-0 flex-1">
                        {pickSnapshotName(i.nameJa, i.nameEn, locale)}
                        {i.note && (
                          <span className="ml-1 rounded bg-brand-tint px-1.5 text-[11px] font-semibold text-brand">
                            {i.note}
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-muted">
                        {t(
                          `kitchenStatus.${i.status === "voided" ? "voided" : (i.kitchenStatus ?? "queued")}`,
                        )}
                      </span>
                      {i.status === "active" &&
                        can("orders.edit") &&
                        session.status !== "closed" && (
                          <button
                            type="button"
                            className="text-[11px] font-semibold text-brand"
                            onClick={() =>
                              setVoidTarget({ id: i.id, prepared: i.kitchenStatus !== "queued" })
                            }
                          >
                            {t("pos.void")}
                          </button>
                        )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
          <div className="border-t border-line-2 bg-panel px-5 py-4">
            <div className="flex justify-between text-[13px] text-ink-2">
              <span>{bill.pricesIncludeTax ? t("pos.subtotal") : t("pos.subtotalExcl")}</span>
              <span>{formatYen(bill.subtotalYen + previewTotal, locale)}</span>
            </div>
            {bill.taxBreakdown.map((x) => (
              <div key={x.rateBp} className="mt-1 flex justify-between text-[13px] text-ink-2">
                <span>
                  {bill.pricesIncludeTax
                    ? t("pos.taxIncluded", { rate: ratePercent(x.rateBp) })
                    : t("pos.tax", { rate: ratePercent(x.rateBp) })}
                </span>
                <span>{formatYen(x.taxYen, locale)}</span>
              </div>
            ))}
            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-[15px] font-semibold">{t("pos.total")}</span>
              <span className="text-[28px] font-bold">
                {formatYen(bill.totalYen + previewTotal, locale)}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <Button
                variant="dark"
                className="h-14 text-[15px]"
                disabled={busy || cart.length === 0 || !canOrder}
                onClick={() => void send()}
              >
                {t("pos.sendToKitchen")}
              </Button>
              {can("checkout.perform") ? (
                <Button
                  variant="brand"
                  className="h-14 text-[15px]"
                  onClick={() => router.push(`/checkout/${sessionId}`)}
                >
                  {t("pos.checkout")}
                </Button>
              ) : (
                <ConfirmButton
                  className="h-14 text-[15px]"
                  label={t("pos.clear")}
                  message={t("pos.clear")}
                  confirmLabel={t("common.confirm")}
                  cancelLabel={t("common.cancel")}
                  onConfirm={() => setCart([])}
                />
              )}
            </div>
          </div>
        </aside>
      </div>
      {voidTarget && (
        <Dialog title={t("pos.void")} onClose={() => setVoidTarget(null)}>
          <p className="text-[14px] text-ink-2">{t("pos.voidConfirm")}</p>
          <label className="mt-3 block text-[13px] font-medium">
            {t("pos.voidReason")}
            <input
              value={voidReason}
              maxLength={200}
              onChange={(e) => setVoidReason(e.target.value)}
              className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
            />
          </label>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Button className="h-12" onClick={() => setVoidTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="brand"
              className="h-12"
              disabled={voidTarget.prepared && !voidReason.trim()}
              onClick={() => void confirmVoid()}
            >
              {t("pos.void")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
