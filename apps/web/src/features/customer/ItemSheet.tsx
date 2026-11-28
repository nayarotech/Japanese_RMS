"use client";
/**
 * Dish detail: full-bleed photo, name, price, description, quantity and the special request for THIS line.
 * No add-ons or modifiers: the menu model has none, so none are shown.
 */
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { MenuItemImage } from "../../components/MenuItemImage";
import { formatYen, pickName } from "../../lib/format";
import { NOTE_MAX, QTY_MAX, noteLength } from "./cart";
import { Sheet } from "./Sheet";
import type { CustomerMenuItem } from "./types";
import { Icon, QuantityStepper, StatusPill, primaryButton } from "./ui";

export function pickDescription(
  d: { ja: string | null; en: string | null },
  locale: string,
): string | null {
  return locale === "en" ? (d.en ?? d.ja) : d.ja;
}

export function ItemSheet({
  item,
  canOrder,
  orderHint,
  priceNote,
  onAdd,
  onClose,
}: {
  item: CustomerMenuItem;
  canOrder: boolean;
  /** Why ordering is not possible right now (shown instead of the Add button). */
  orderHint: string | null;
  /** e.g. "tax incl." when the store's prices include tax. */
  priceNote: string | null;
  onAdd: (quantity: number, note: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("customer");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const noteId = useId();
  const counterId = useId();
  const name = pickName(item.name, locale);
  const description = pickDescription(item.description, locale);
  const orderable = canOrder && item.isAvailable;
  const length = noteLength(note);

  return (
    <Sheet
      title={name}
      closeLabel={tc("close")}
      onClose={onClose}
      // No photo: a plain titled sheet instead of a large empty placeholder.
      hideTitle
      media={
        item.image ? (
          <MenuItemImage
            image={item.image}
            name={name}
            sizes="(min-width: 640px) 520px, 100vw"
            eager
            placeholder="neutral"
            className={`aspect-[4/3] w-full ${item.isAvailable ? "" : "grayscale"}`}
            letterClassName="text-[64px]"
          />
        ) : undefined
      }
      footer={
        orderable ? (
          <div className="flex items-center gap-3">
            <QuantityStepper
              value={quantity}
              min={1}
              max={QTY_MAX}
              onChange={setQuantity}
              labels={{ dec: tc("decrease"), inc: tc("increase") }}
            />
            <button
              type="button"
              onClick={() => onAdd(quantity, note)}
              className={`${primaryButton} min-w-0 flex-1 justify-between`}
            >
              <span className="truncate">{t("addToOrder")}</span>
              <span className="tabular-nums">{formatYen(item.priceYen * quantity, locale)}</span>
            </button>
          </div>
        ) : (
          <p className="py-2 text-center text-[14px] font-semibold text-muted">
            {!item.isAvailable ? t("soldOut") : orderHint}
          </p>
        )
      }
    >
      <div className={`px-5 pb-6 ${item.image ? "pt-5" : "pt-1"}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[22px] leading-snug font-bold break-words [word-break:auto-phrase]">
              {name}
            </h3>
            {locale === "en" && item.name.en && (
              <p className="mt-0.5 text-[13px] text-muted" lang="ja">
                {item.name.ja}
              </p>
            )}
          </div>
          {!item.isAvailable && <StatusPill tone="neutral">{t("soldOut")}</StatusPill>}
        </div>
        <p className="mt-2 flex items-baseline gap-1.5">
          <span className="text-[22px] font-bold tabular-nums">
            {formatYen(item.priceYen, locale)}
          </span>
          {priceNote && <span className="text-[12px] font-medium text-muted">{priceNote}</span>}
        </p>
        {description && (
          <p className="mt-3 text-[15px] leading-[1.75] whitespace-pre-line text-ink-2">
            {description}
          </p>
        )}

        {orderable && (
          <div className="mt-6 border-t border-line-soft pt-5">
            <label htmlFor={noteId} className="flex items-center gap-2">
              <Icon.Note className="size-[18px] text-muted" />
              <span className="flex-1 text-[15px] font-bold">{t("requestLabel")}</span>
              <span
                id={counterId}
                className={`text-[12px] tabular-nums ${length >= NOTE_MAX ? "font-bold text-brand-dark" : "text-muted"}`}
              >
                {length}/{NOTE_MAX}
              </span>
            </label>
            <textarea
              id={noteId}
              rows={2}
              value={note}
              aria-describedby={counterId}
              onChange={(e) => setNote(Array.from(e.target.value).slice(0, NOTE_MAX).join(""))}
              placeholder={t("requestPlaceholder")}
              className="mt-2.5 w-full resize-none rounded-[12px] border border-line bg-panel px-3.5 py-3 text-[15px] leading-relaxed transition-colors placeholder:text-placeholder focus:border-ink focus:bg-white"
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{t("requestHint")}</p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
