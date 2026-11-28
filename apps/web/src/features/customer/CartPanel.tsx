"use client";
/**
 * Cart contents (inside the phone cart sheet and the desktop side panel): photo, name, price, quantity, the
 * per-line request (editable until the order is sent), remove, and "different request for one". Lines whose dish was
 * removed or sold out since it was added are flagged with a one-tap fix.
 */
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { MenuItemImage } from "../../components/MenuItemImage";
import { formatYen, pickName } from "../../lib/format";
import { type Cart, NOTE_MAX, type ResolvedLine, noteLength } from "./cart";
import { EmptyState, Icon, QuantityStepper } from "./ui";

export function CartPanel({
  cart,
  totalLabel,
  action,
  footnote,
}: {
  cart: Cart;
  totalLabel: string;
  /** The primary action under the total (Send order / Go to checkout). */
  action: ReactNode;
  /** Small print under the total (e.g. "fees and tax are confirmed at checkout"). */
  footnote?: string;
}) {
  const t = useTranslations("customer");
  const locale = useLocale();
  if (cart.lines.length === 0)
    return (
      <EmptyState
        icon={<Icon.Bag className="size-6" />}
        title={t("cartEmpty")}
        hint={t("cartEmptyHint")}
      />
    );
  return (
    <div>
      {cart.problems.length > 0 && (
        <div role="alert" className="mx-5 mt-1 mb-1 rounded-[14px] bg-brand-tint px-4 py-3">
          <p className="text-[14px] font-bold text-brand-dark">
            {t("cartChanged", { count: cart.problems.length })}
          </p>
          <button
            type="button"
            onClick={cart.removeProblems}
            className="mt-1.5 text-[13px] font-bold text-brand-dark underline underline-offset-2"
          >
            {t("removeUnavailable")}
          </button>
        </div>
      )}
      <ul className="divide-y divide-line-soft px-5">
        {cart.lines.map((l) => (
          <CartItem key={l.key} line={l} cart={cart} />
        ))}
      </ul>
      <div className="mx-5 border-t border-line pt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-semibold text-ink-2">
            {totalLabel}
            <span className="ml-1.5 text-[13px] font-medium text-muted">
              {t("itemsCount", { count: cart.count })}
            </span>
          </span>
          <span className="text-[22px] font-bold tabular-nums">
            {formatYen(cart.subtotal, locale)}
          </span>
        </div>
        {footnote && <p className="mt-1 text-right text-[12px] text-muted">{footnote}</p>}
      </div>
      <div className="px-5 pt-4 pb-5">{action}</div>
    </div>
  );
}

export function CartItem({ line, cart }: { line: ResolvedLine; cart: Cart }) {
  const t = useTranslations("customer");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const noteId = useId();
  const name = line.item ? pickName(line.item.name, locale) : pickName(line.name, locale);
  const note = line.note.trim();
  return (
    <li className="py-4">
      <div className="flex gap-3.5">
        <MenuItemImage
          image={line.item?.image ?? null}
          name={name}
          placeholder="neutral"
          className={`size-16 rounded-[14px] ${line.problem ? "opacity-50 grayscale" : ""}`}
          letterClassName="text-[22px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 text-[15px] leading-snug font-bold break-words [word-break:auto-phrase]">
              {name}
            </p>
            {line.item && !line.problem && (
              <span className="shrink-0 text-[15px] font-bold tabular-nums">
                {formatYen(line.item.priceYen * line.quantity, locale)}
              </span>
            )}
          </div>
          {line.problem ? (
            <p className="mt-1 text-[13px] font-bold text-brand-dark">
              {line.problem === "removed" ? t("lineRemoved") : t("lineSoldOut")}
            </p>
          ) : (
            line.item && (
              <p className="mt-0.5 text-[12px] text-muted tabular-nums">
                {t("each", { price: formatYen(line.item.priceYen, locale) })}
              </p>
            )
          )}
          {!editing && note && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={!!line.problem}
              className="mt-2 flex w-full items-start gap-1.5 rounded-[10px] bg-panel px-2.5 py-2 text-left text-[13px] leading-snug text-ink-2 ring-1 ring-line-soft"
            >
              <Icon.Note className="mt-px size-4 shrink-0 text-muted" />
              <span className="min-w-0 break-words">
                <span className="sr-only">{t("requestLabel")}: </span>
                {line.note}
              </span>
            </button>
          )}
        </div>
      </div>

      {editing && !line.problem && (
        <div className="rp-fade mt-3">
          <label htmlFor={noteId} className="flex justify-between text-[13px] font-bold">
            {t("requestLabel")}
            <span className="font-normal text-muted tabular-nums">
              {noteLength(line.note)}/{NOTE_MAX}
            </span>
          </label>
          <textarea
            id={noteId}
            rows={2}
            value={line.note}
            autoFocus
            onChange={(e) => cart.setNote(line.key, e.target.value)}
            placeholder={t("requestPlaceholder")}
            className="mt-1.5 w-full resize-none rounded-[12px] border border-line bg-white px-3 py-2.5 text-[15px] placeholder:text-placeholder focus:border-ink"
          />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 sm:pl-[78px]">
        {!line.problem && (
          <QuantityStepper
            size="sm"
            value={line.quantity}
            onChange={(q) => cart.setQuantity(line.key, q)}
            labels={{ dec: tc("decrease"), inc: tc("increase") }}
          />
        )}
        <button
          type="button"
          onClick={() => cart.remove(line.key)}
          aria-label={t("removeNamed", { name })}
          className="ml-auto rounded-full px-3 py-2 text-[13px] font-semibold text-brand-dark transition-colors hover:bg-brand-tint"
        >
          {t("remove")}
        </button>
      </div>
      {!line.problem && (
        <div className="mt-1 flex flex-wrap gap-x-1 text-[13px] font-semibold sm:pl-[74px]">
          <button
            type="button"
            aria-expanded={editing}
            onClick={() => setEditing((v) => !v)}
            className="rounded-full px-2.5 py-2 text-ink-2 transition-colors hover:bg-chip"
          >
            {editing ? t("doneEditing") : note ? t("editRequest") : t("addRequest")}
          </button>
          {line.quantity > 1 && (
            <button
              type="button"
              onClick={() => cart.split(line.key)}
              className="rounded-full px-2.5 py-2 text-ink-2 transition-colors hover:bg-chip"
            >
              {t("splitLine")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Sticky phone summary: "3 · View order · ¥2,450". Sits above the safe area and below sheets. */
export function CartBar({
  count,
  subtotal,
  label,
  onOpen,
}: {
  count: number;
  subtotal: number;
  label: string;
  onOpen: () => void;
}) {
  const t = useTranslations("customer");
  const locale = useLocale();
  return (
    <div className="rp-sheet pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom))] bg-linear-to-t from-white from-55% to-white/0 lg:hidden">
      <button
        type="button"
        onClick={onOpen}
        className="pointer-events-auto mx-auto flex h-14 w-full max-w-[560px] items-center gap-3 rounded-[18px] bg-ink pr-5 pl-2.5 text-white shadow-xl shadow-ink/25 transition-transform active:scale-[0.98]"
      >
        <span
          key={count}
          className="rp-pop flex size-9 items-center justify-center rounded-[12px] bg-white/15 text-[15px] font-bold tabular-nums"
        >
          {count}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-[16px] font-bold">{label}</span>
        <span className="text-[16px] font-bold tabular-nums">{formatYen(subtotal, locale)}</span>
        <span className="sr-only">{t("itemsCount", { count })}</span>
      </button>
    </div>
  );
}
