"use client";
/**
 * Menu browsing shared by the table-QR menu and the online storefront: a menu heading, local search, sticky
 * horizontal category tabs that follow the scroll position, and every category as a section on one page.
 *
 * The page sets `--header-h` (its sticky header height) so the tabs and section anchors sit just below it.
 */
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { MenuItemImage } from "../../components/MenuItemImage";
import { formatYen, pickName } from "../../lib/format";
import { pickDescription } from "./ItemSheet";
import { searchMenu } from "./search";
import type { CustomerCategory, CustomerMenuItem } from "./types";
import { EmptyState, Icon } from "./ui";

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function MenuBrowser({
  menu,
  canOrder,
  quantityOf,
  onOpen,
  onQuickAdd,
  before,
}: {
  menu: readonly CustomerCategory[];
  canOrder: boolean;
  quantityOf: (itemId: string) => number;
  onOpen: (item: CustomerMenuItem) => void;
  onQuickAdd: (item: CustomerMenuItem) => void;
  /** Rendered between the search and the first category (e.g. featured dishes); hidden while searching. */
  before?: ReactNode;
}) {
  const t = useTranslations("customer");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(menu[0]?.id ?? null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const lockUntil = useRef(0);
  const results = useMemo(() => searchMenu(menu, query), [menu, query]);
  const searching = query.trim().length > 0;
  const total = menu.reduce((n, c) => n + c.items.length, 0);

  // Scroll spy: the category whose heading last passed under the sticky bars is the active tab.
  useEffect(() => {
    if (searching) return;
    const sections = menu
      .map((c) => document.getElementById(`cat-${c.id}`))
      .filter((x): x is HTMLElement => x !== null);
    if (sections.length === 0) return;
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        if (Date.now() < lockUntil.current) return;
        const first = sections.find((s) => visible.get(s.id));
        if (first) setActive(first.id.slice(4));
      },
      { rootMargin: "-130px 0px -55% 0px" },
    );
    for (const s of sections) io.observe(s);
    return () => io.disconnect();
  }, [menu, searching]);

  // Keep the active tab visible in the horizontal strip.
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-cat="${active ?? ""}"]`);
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.clientWidth / 2 + tab.clientWidth / 2;
    strip.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [active]);

  const goTo = (id: string) => {
    setActive(id);
    lockUntil.current = Date.now() + 800;
    document
      .getElementById(`cat-${id}`)
      ?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  };

  const card = (i: CustomerMenuItem) => (
    <FoodCard
      key={i.id}
      item={i}
      canOrder={canOrder}
      inCart={quantityOf(i.id)}
      onOpen={() => onOpen(i)}
      onQuickAdd={() => onQuickAdd(i)}
    />
  );

  return (
    <div>
      <div className="px-4 pt-6 sm:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[22px] font-bold tracking-tight">{t("menuTitle")}</h2>
          {total > 0 && (
            <span className="text-[13px] text-muted">{t("menuCount", { count: total })}</span>
          )}
        </div>
        <label className="relative mt-3 block">
          <span className="sr-only">{t("searchLabel")}</span>
          <span
            aria-hidden
            className="nav-icon absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted"
            style={{ maskImage: "url(/icons/search.svg)" }}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            enterKeyHint="search"
            className="h-12 w-full rounded-[14px] border border-transparent bg-chip pr-4 pl-11 text-[16px] transition-colors placeholder:text-muted focus:border-ink focus:bg-white"
          />
        </label>
      </div>

      {!searching && menu.length > 1 && (
        <nav
          aria-label={t("categories")}
          className="sticky top-[var(--header-h)] z-20 mt-3 border-b border-line-soft bg-white/95 backdrop-blur"
        >
          <div
            ref={tabsRef}
            className="flex gap-1.5 overflow-x-auto px-4 py-2.5 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-28px),transparent)] [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
          >
            {menu.map((c) => (
              <button
                key={c.id}
                type="button"
                data-cat={c.id}
                aria-current={active === c.id ? "true" : undefined}
                onClick={() => goTo(c.id)}
                className={`h-10 shrink-0 rounded-full px-4 text-[14px] font-semibold whitespace-nowrap transition-[background-color,color,transform] active:scale-95 ${active === c.id ? "bg-ink text-white" : "text-ink-2 hover:bg-chip"}`}
              >
                {pickName(c.name, locale)}
              </button>
            ))}
          </div>
        </nav>
      )}

      {searching ? (
        <section aria-live="polite" className="rp-fade px-4 pt-5 sm:px-6">
          <h2 className="text-[13px] font-semibold text-muted">
            {t("searchResults", { count: results.length })}
          </h2>
          {results.length === 0 ? (
            <EmptyState
              icon={
                <span
                  aria-hidden
                  className="nav-icon size-6"
                  style={{ maskImage: "url(/icons/search.svg)" }}
                />
              }
              title={t("noResultsTitle")}
              hint={t("noResults")}
            />
          ) : (
            <ul className="grid grid-cols-1 md:grid-cols-2 md:gap-x-8">{results.map(card)}</ul>
          )}
        </section>
      ) : (
        <>
          {before}
          {menu.map((c) => (
            <section
              key={c.id}
              id={`cat-${c.id}`}
              aria-labelledby={`cath-${c.id}`}
              className="scroll-mt-[calc(var(--header-h)+64px)] px-4 pt-7 sm:px-6"
            >
              <h3
                id={`cath-${c.id}`}
                className="flex items-baseline gap-2 text-[18px] font-bold tracking-tight"
              >
                {pickName(c.name, locale)}
                <span className="text-[13px] font-medium text-muted">{c.items.length}</span>
              </h3>
              <ul className="grid grid-cols-1 md:grid-cols-2 md:gap-x-8">{c.items.map(card)}</ul>
            </section>
          ))}
          {menu.length === 0 && (
            <EmptyState icon={<Icon.Bag className="size-6" />} title={t("menuEmpty")} />
          )}
        </>
      )}
    </div>
  );
}

/** One dish: text on the left (name, two-line description, price), photo with the add control on the right. */
export function FoodCard({
  item,
  canOrder,
  inCart,
  onOpen,
  onQuickAdd,
}: {
  item: CustomerMenuItem;
  canOrder: boolean;
  inCart: number;
  onOpen: () => void;
  onQuickAdd: () => void;
}) {
  const t = useTranslations("customer");
  const locale = useLocale();
  const name = pickName(item.name, locale);
  const description = pickDescription(item.description, locale);
  return (
    <li className="group relative border-b border-line-soft last:border-b-0 md:last:border-b md:[&:nth-last-child(2):nth-child(odd)]:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("openItem", { name })}
        className="flex w-full items-start gap-4 rounded-[16px] py-4 text-left transition-colors"
      >
        <span className="flex min-h-[112px] min-w-0 flex-1 flex-col">
          <span
            className={`block text-[16px] leading-snug font-bold break-words [word-break:auto-phrase] ${item.isAvailable ? "" : "text-muted"}`}
          >
            {name}
          </span>
          {description && (
            <span className="mt-1 line-clamp-2 block text-[13px] leading-relaxed text-muted">
              {description}
            </span>
          )}
          <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2">
            <span
              className={`text-[16px] font-bold tabular-nums ${item.isAvailable ? "" : "text-muted line-through decoration-1"}`}
            >
              {formatYen(item.priceYen, locale)}
            </span>
            {inCart > 0 && (
              <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[12px] font-bold text-brand-dark">
                {t("inOrder", { count: inCart })}
              </span>
            )}
          </span>
        </span>
        <span className="relative shrink-0">
          <MenuItemImage
            image={item.image}
            name={name}
            placeholder="neutral"
            className={`size-[112px] rounded-[16px] motion-safe:[&_img]:group-hover:scale-[1.04] ${item.isAvailable ? "" : "grayscale"}`}
            letterClassName="text-[34px]"
          />
          {!item.isAvailable && (
            <span className="absolute inset-0 flex items-center justify-center rounded-[16px] bg-ink/45">
              <span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-ink">
                {t("soldOut")}
              </span>
            </span>
          )}
        </span>
      </button>
      {canOrder && item.isAvailable && (
        <button
          type="button"
          onClick={onQuickAdd}
          aria-label={t("quickAdd", { name })}
          className={`absolute right-2 bottom-6 flex size-10 items-center justify-center rounded-full shadow-md shadow-ink/20 ring-2 ring-white transition-[transform,background-color] hover:-translate-y-0.5 active:scale-90 ${inCart > 0 ? "bg-brand text-white" : "bg-white text-brand"}`}
        >
          {inCart > 0 ? (
            <span key={inCart} className="rp-pop text-[14px] font-bold tabular-nums">
              {inCart}
            </span>
          ) : (
            <Icon.Plus className="size-5" />
          )}
        </button>
      )}
    </li>
  );
}
