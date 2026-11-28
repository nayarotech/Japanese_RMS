"use client";
/**
 * Public online-ordering storefront (pickup / delivery, guest checkout, no account).
 *
 * Journey: storefront (identity, hours, how to receive, featured dishes, menu) -> cart -> focused checkout -> status.
 * Every amount before checkout is a preview from the menu. Checkout shows the SERVER quote (prices, delivery fee from
 * the server-verified address, tax); the order is submitted with that reviewed total, which the server only compares.
 * Delivery is never called available for an address until the server has checked it.
 */
import type {
  DeliveryAddressInput,
  FulfillmentType,
  OnlineOrderPlacedDto,
  OnlineQuoteDto,
  StorefrontResponse,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MenuItemImage } from "../../../components/MenuItemImage";
import { Banner } from "../../../components/ui";
import { CartBar, CartPanel } from "../../../features/customer/CartPanel";
import {
  CustomerHeader,
  RestaurantMark,
  accentStyle,
} from "../../../features/customer/CustomerHeader";
import { ItemSheet, pickDescription } from "../../../features/customer/ItemSheet";
import { MenuBrowser } from "../../../features/customer/MenuBrowser";
import { Sheet } from "../../../features/customer/Sheet";
import { useCart } from "../../../features/customer/cart";
import type { CustomerMenuItem } from "../../../features/customer/types";
import {
  CartButton,
  EmptyState,
  Icon,
  PageSkeleton,
  SectionCard,
  Spinner,
  StatusPill,
  primaryButton,
  secondaryButton,
} from "../../../features/customer/ui";
import {
  clearSubmissionKey,
  loadRecentOrder,
  markJustPlaced,
  saveRecentOrder,
  submissionKey,
} from "../../../features/online/recent";
import { ApiError, newIdempotencyKey, publicRequest } from "../../../lib/api";
import { formatTime, formatYen, pickName, ratePercent } from "../../../lib/format";

type T = ReturnType<typeof useTranslations>;

const SHOP_ERRORS = new Set([
  "address_not_found",
  "address_not_precise",
  "outside_delivery_area",
  "geocoding_unavailable",
  "delivery_unavailable",
  "below_minimum_order",
  "total_changed",
  "invalid_pickup_time",
  "store_closed",
  "ordering_paused",
  "ordering_unavailable",
  "item_unavailable",
  "item_not_found",
  "too_many_pending_orders",
  "rate_limited",
  "validation_failed",
  "store_busy",
]);

function errorText(t: T, err: unknown): string {
  if (err instanceof ApiError && SHOP_ERRORS.has(err.code)) return t(`shopErrors.${err.code}`);
  if (err instanceof ApiError && (err.status === 0 || err.status >= 500))
    return t("customer.retrySafe");
  return t("errors.generic");
}

const emptyAddress: DeliveryAddressInput = {
  postalCode: "",
  prefecture: "",
  city: "",
  line1: "",
  line2: "",
  instructions: "",
};

/** Small non-cryptographic hash: detects "same request" without keeping personal data in storage. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function weekdayIn(tz: string, d = new Date()): number {
  return (
    WEEKDAY[new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d)] ?? 0
  );
}

function dayLabel(t: T, iso: string, tz: string, locale: string): string {
  const key = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const day = key(new Date(iso));
  if (day === key(new Date())) return t("shop.today");
  if (day === key(new Date(Date.now() + 86_400_000))) return t("shop.tomorrow");
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-GB", {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: tz,
  }).format(new Date(iso));
}

export default function StorefrontPage() {
  const { token } = useParams<{ token: string }>();
  const t = useTranslations();
  const tc = useTranslations("customer");
  const locale = useLocale();
  const router = useRouter();
  const [store, setStore] = useState<StorefrontResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [type, setType] = useState<FulfillmentType | null>(null);
  const [view, setView] = useState<"menu" | "checkout">("menu");
  const [openItem, setOpenItem] = useState<CustomerMenuItem | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const [address, setAddress] = useState<DeliveryAddressInput>(emptyAddress);
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [quote, setQuote] = useState<OnlineQuoteDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"quote" | "order" | null>(null);
  const [recent, setRecent] = useState<{ token: string; orderNo: number } | null>(null);

  const loadStore = useCallback(
    () =>
      publicRequest<StorefrontResponse>("GET", `/public/stores/${token}`)
        .then((s) => {
          setStore(s);
          setType((ty) =>
            ty && s[ty] ? ty : s.pickup ? "pickup" : s.delivery ? "delivery" : null,
          );
          setSlot((cur) =>
            cur && s.pickup?.slots.includes(cur) ? cur : (s.pickup?.slots[0] ?? null),
          );
          return s;
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && (err.status === 404 || err.status === 400))
            setNotFound(true);
          else setMessage(errorText(t, err));
          return null;
        }),
    [token, t],
  );
  useEffect(() => {
    void loadStore();
    setRecent(loadRecentOrder(token));
  }, [loadStore, token]);

  const menuMap = useMemo(
    () =>
      store ? new Map(store.menu.flatMap((c) => c.items.map((i) => [i.id, i] as const))) : null,
    [store],
  );
  const cart = useCart(`rp_online_cart:${token}`, menuMap, "local");
  const canOrder = store?.state === "open" && type !== null;
  const signature = `${type ?? ""}|${JSON.stringify(cart.orderLines)}`;
  // Any change to what is being priced invalidates the server quote.
  useEffect(() => setQuote(null), [signature]);

  async function requestQuote() {
    if (!type || cart.orderLines.length === 0) return;
    setBusy("quote");
    setMessage(null);
    try {
      setQuote(
        await publicRequest<OnlineQuoteDto>("POST", `/public/stores/${token}/quote`, {
          body: {
            fulfillmentType: type,
            items: cart.orderLines,
            address: type === "delivery" ? address : null,
          },
        }),
      );
    } catch (err) {
      setQuote(null);
      setMessage(errorText(t, err));
      if (
        err instanceof ApiError &&
        (err.code === "item_unavailable" || err.code === "item_not_found")
      )
        void loadStore();
    } finally {
      setBusy(null);
    }
  }

  // Pickup has no address to check: quote once per (type, cart) when the checkout opens or the cart changes.
  const quotedFor = useRef<string | null>(null);
  useEffect(() => {
    if (view !== "checkout" || type !== "pickup" || quote || cart.orderLines.length === 0) return;
    if (cart.problems.length > 0 || quotedFor.current === signature) return;
    quotedFor.current = signature;
    void requestQuote();
  }, [view, type, quote, signature, cart.orderLines.length, cart.problems.length]); // requestQuote reads the latest state

  async function goToCheckout() {
    setCartOpen(false);
    setMessage(null);
    // Revalidate availability and prices before the customer fills in the form.
    await loadStore();
    quotedFor.current = null;
    setView("checkout");
    window.scrollTo({ top: 0 });
  }

  async function placeOrder() {
    if (!quote || !type) return;
    setBusy("order");
    setMessage(null);
    const body = {
      fulfillmentType: type,
      items: cart.orderLines,
      ...(type === "pickup" ? { pickupTime: slot } : { address }),
      contact: { name: contact.name, phone: contact.phone, email: contact.email.trim() || null },
      paymentMethod: type === "pickup" ? "pay_on_pickup" : "cash_on_delivery",
      expectedTotalYen: quote.totalYen,
    };
    const key = submissionKey(token, fnv1a(JSON.stringify(body)), newIdempotencyKey);
    try {
      const placed = await publicRequest<OnlineOrderPlacedDto>(
        "POST",
        `/public/stores/${token}/orders`,
        { idempotencyKey: key, body },
      );
      clearSubmissionKey(token);
      saveRecentOrder(token, { token: placed.trackingToken, orderNo: placed.orderNo });
      markJustPlaced({
        trackingToken: placed.trackingToken,
        storeToken: token,
        orderNo: placed.orderNo,
      });
      cart.clear();
      router.push(`/order/status#${placed.trackingToken}`);
    } catch (err) {
      setMessage(errorText(t, err));
      if (
        err instanceof ApiError &&
        ["total_changed", "invalid_pickup_time", "item_unavailable", "item_not_found"].includes(
          err.code,
        )
      ) {
        setQuote(null);
        quotedFor.current = null;
        void loadStore();
      }
      setBusy(null);
    }
  }

  if (notFound)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-white">
        <EmptyState icon={<Icon.Bag className="size-6" />} title={t("shop.notFound")} />
      </main>
    );
  if (!store) return <PageSkeleton variant="store" label={t("common.loading")} />;

  const name = store.profile.displayName ?? store.location.name;
  const stateText =
    store.state === "unavailable"
      ? t("shop.unavailable")
      : store.state === "paused"
        ? t("shop.paused")
        : store.state === "closed"
          ? t("shop.closed")
          : null;
  const orderHint = stateText ?? tc("online.chooseFulfillment");
  const belowMin = (store.minOrderYen ?? 0) > cart.subtotal;
  const featured = store.featuredItemIds
    .map((id) => menuMap?.get(id))
    .filter((i): i is CustomerMenuItem => !!i);

  const checkoutButton = (
    <>
      <button
        type="button"
        disabled={!canOrder || cart.orderLines.length === 0 || cart.problems.length > 0}
        onClick={() => void goToCheckout()}
        className={primaryButton}
      >
        {tc("online.toCheckout")}
      </button>
      {!canOrder && <p className="mt-2 text-center text-[12px] text-muted">{orderHint}</p>}
      {canOrder && belowMin && (store.minOrderYen ?? 0) > 0 && (
        <p className="mt-2 text-center text-[12px] text-muted">
          {t("shop.minimum", { amount: formatYen(store.minOrderYen ?? 0, locale) })}
        </p>
      )}
    </>
  );
  const cartPanel = (
    <CartPanel
      cart={cart}
      totalLabel={tc("online.itemsPreview")}
      footnote={tc("online.feesAtCheckout")}
      action={checkoutButton}
    />
  );

  const header = (
    <CustomerHeader
      logo={store.profile.logo}
      name={name}
      subtitle={store.profile.displayName ? store.location.name : undefined}
      action={
        view === "menu" ? (
          <CartButton
            count={cart.count}
            label={tc("cartButton", { count: cart.count })}
            onClick={() => setCartOpen(true)}
          />
        ) : undefined
      }
    />
  );

  if (view === "checkout")
    return (
      <div style={accentStyle(store.profile.accentColor)} className="min-h-dvh bg-canvas">
        {header}
        <Checkout
          store={store}
          name={name}
          cart={cart}
          type={type}
          setType={(ft) => {
            setType(ft);
            setMessage(null);
          }}
          slot={slot}
          setSlot={setSlot}
          address={address}
          setAddress={(a) => {
            setAddress(a);
            setQuote(null);
          }}
          contact={contact}
          setContact={setContact}
          quote={quote}
          busy={busy}
          message={message}
          onQuote={() => void requestQuote()}
          onPlace={() => void placeOrder()}
          onBack={() => {
            setView("menu");
            setMessage(null);
          }}
        />
      </div>
    );

  return (
    <div style={accentStyle(store.profile.accentColor)} className="min-h-dvh bg-white lg:bg-canvas">
      {header}
      <div className="mx-auto max-w-[1180px] lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6 lg:px-6 lg:py-6">
        <main className="min-w-0 bg-white pb-32 lg:rounded-[24px] lg:pb-10 lg:shadow-sm lg:shadow-ink/5 lg:ring-1 lg:ring-line-soft">
          <StoreHero store={store} name={name} />
          {(recent || message) && (
            <div className="space-y-2 px-4 pt-3 sm:px-6">
              {recent && (
                <a
                  href={`/order/status#${recent.token}`}
                  className="flex items-center gap-3 rounded-[14px] bg-green-50 px-4 py-3 text-[14px] font-semibold text-ok transition-colors hover:brightness-[0.98]"
                >
                  <Icon.Check className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {t("shop.recentOrder", { no: String(recent.orderNo).padStart(4, "0") })}
                  </span>
                  <span aria-hidden>→</span>
                </a>
              )}
              {message && <Banner>{message}</Banner>}
            </div>
          )}
          {store.state !== "unavailable" && (
            <FulfillmentSelector store={store} type={type} setType={setType} />
          )}
          <MenuBrowser
            menu={store.menu}
            canOrder={canOrder}
            quantityOf={cart.quantityOf}
            onOpen={setOpenItem}
            onQuickAdd={(i) => cart.add(i, 1, "")}
            before={
              featured.length > 0 ? (
                <FeaturedRail
                  items={featured}
                  canOrder={canOrder}
                  quantityOf={cart.quantityOf}
                  onOpen={setOpenItem}
                  onQuickAdd={(i) => cart.add(i, 1, "")}
                />
              ) : undefined
            }
          />
          <StoreFooter store={store} />
        </main>
        <aside className="hidden lg:block" aria-label={t("shop.yourOrder")}>
          <div className="sticky top-[calc(var(--header-h)+24px)] max-h-[calc(100dvh-var(--header-h)-48px)] overflow-y-auto rounded-[24px] bg-white shadow-sm shadow-ink/5 ring-1 ring-line-soft">
            <h2 className="px-5 pt-5 pb-1 text-[18px] font-bold">{t("shop.yourOrder")}</h2>
            {cartPanel}
          </div>
        </aside>
      </div>

      {cart.lines.length > 0 && !cartOpen && (
        <CartBar
          count={cart.count}
          subtotal={cart.subtotal}
          label={tc("viewOrder")}
          onOpen={() => setCartOpen(true)}
        />
      )}
      {cartOpen && (
        <Sheet
          title={t("shop.yourOrder")}
          closeLabel={t("common.close")}
          onClose={() => setCartOpen(false)}
        >
          {cartPanel}
        </Sheet>
      )}
      {openItem && (
        <ItemSheet
          item={openItem}
          canOrder={canOrder}
          orderHint={orderHint}
          priceNote={store.pricesIncludeTax === false ? null : tc("taxIncluded")}
          onClose={() => setOpenItem(null)}
          onAdd={(q, note) => {
            cart.add(openItem, q, note);
            setOpenItem(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- storefront sections

function todayHours(store: StorefrontResponse, t: T): string {
  const today = weekdayIn(store.location.timeZone);
  const windows = store.hours.filter((h) => h.weekday === today);
  return windows.length === 0
    ? t("customer.online.closedToday")
    : t("customer.online.todayHours", {
        hours: windows.map((h) => `${h.opensAt}–${h.closesAt}`).join(", "),
      });
}

function StoreHero({ store, name }: { store: StorefrontResponse; name: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const p = store.profile;
  const description = pickDescription(p.description, locale);
  const address = locale === "en" ? (p.address.en ?? p.address.ja) : p.address.ja;
  const announcement =
    locale === "en" ? (p.announcement.en ?? p.announcement.ja) : p.announcement.ja;
  const tone = { open: "ok", closed: "neutral", paused: "brand", unavailable: "neutral" } as const;
  return (
    <section aria-labelledby="store-name">
      {p.cover && (
        <div className="px-4 pt-4 sm:px-6 lg:pt-6">
          <MenuItemImage
            image={p.cover}
            name=""
            sizes="(min-width: 1024px) 760px, 100vw"
            eager
            placeholder="neutral"
            className="aspect-[16/7] max-h-[168px] w-full rounded-[20px] sm:max-h-[220px] lg:max-h-[196px] lg:rounded-[22px]"
          />
        </div>
      )}
      <div className="px-4 sm:px-6">
        <div className={`flex items-end gap-3.5 ${p.cover ? "-mt-7 pl-3" : "pt-5"}`}>
          <RestaurantMark
            logo={p.logo}
            name={name}
            className="relative size-16 rounded-[18px] text-[26px] shadow-md shadow-ink/10 ring-4 ring-white"
          />
          {!p.cover && (
            <div className="min-w-0 pb-1">
              <StatusPill tone={tone[store.state]} dot>
                {t(`customer.online.state_${store.state}`)}
              </StatusPill>
            </div>
          )}
        </div>
        <h1
          id="store-name"
          className="mt-3 text-[24px] leading-tight font-bold tracking-tight break-words [word-break:auto-phrase] sm:text-[30px]"
        >
          {name}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-2">
          {p.cover && (
            <StatusPill tone={tone[store.state]} dot>
              {t(`customer.online.state_${store.state}`)}
            </StatusPill>
          )}
          {p.displayName && <span className="font-medium">{store.location.name}</span>}
          {store.state !== "unavailable" && (
            <span className="inline-flex items-center gap-1">
              <Icon.Clock className="size-4 text-muted" />
              {todayHours(store, t)}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-3 line-clamp-3 text-[14px] leading-[1.75] whitespace-pre-line text-ink-2 sm:line-clamp-none sm:text-[15px]">
            {description}
          </p>
        )}
        {(address || p.phone || store.hours.length > 0) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-2">
            {address && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Icon.Pin className="size-4 shrink-0 text-muted" />
                <span className="truncate">{address}</span>
              </span>
            )}
            {p.phone && (
              <a
                href={`tel:${p.phone.replace(/[^0-9+]/g, "")}`}
                className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
              >
                <Icon.Phone className="size-4 text-muted" />
                {p.phone}
              </a>
            )}
          </div>
        )}
        {store.hours.length > 0 && (
          <details className="group mt-1.5 text-[13px]">
            <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 font-semibold text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
              {t("shop.hours")}
              <Icon.Chevron className="size-4 transition-transform group-open:rotate-180" />
            </summary>
            <ul className="rp-fade mt-1 grid grid-cols-1 gap-1 rounded-[14px] bg-panel px-4 py-3 ring-1 ring-line-soft sm:grid-cols-2">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const w = store.hours.filter((h) => h.weekday === d);
                return (
                  <li key={d} className="flex gap-3 tabular-nums">
                    <span className="w-8 font-bold">{t(`weekdays.${String(d)}`)}</span>
                    <span className="text-ink-2">
                      {w.length === 0
                        ? t("customer.online.closedDay")
                        : w.map((h) => `${h.opensAt}–${h.closesAt}`).join(", ")}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
        {announcement && (
          <p className="mt-3 rounded-[14px] bg-panel px-4 py-3 text-[14px] leading-relaxed text-ink-2 ring-1 ring-line-soft">
            {announcement}
          </p>
        )}
        {store.state !== "open" && (
          <div className="mt-3">
            <Banner tone="info">
              {store.state === "unavailable"
                ? t("shop.unavailable")
                : store.state === "paused"
                  ? t("shop.paused")
                  : t("shop.closed")}
            </Banner>
          </div>
        )}
      </div>
    </section>
  );
}

function FulfillmentSelector({
  store,
  type,
  setType,
}: {
  store: StorefrontResponse;
  type: FulfillmentType | null;
  setType: (t: FulfillmentType) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const tz = store.location.timeZone;
  const nextSlot = store.pickup?.slots[0];
  const fees = store.delivery?.tiers ?? [];
  const sub = (ft: FulfillmentType) =>
    ft === "pickup"
      ? store.pickup
        ? t("customer.online.pickupShort", { minutes: store.pickup.prepMinutes })
        : t("customer.online.notOffered")
      : store.delivery
        ? t("customer.online.deliveryShort", { km: (store.delivery.radiusM / 1000).toFixed(1) })
        : t("customer.online.notOffered");
  return (
    <section aria-labelledby="receive" className="px-4 pt-5 sm:px-6">
      <h2 id="receive" className="sr-only">
        {t("shop.howToReceive")}
      </h2>
      <div
        role="radiogroup"
        aria-labelledby="receive"
        className="grid grid-cols-2 gap-1 rounded-[18px] bg-chip p-1 sm:max-w-[520px]"
      >
        {(["pickup", "delivery"] as const).map((ft) => {
          const on = type === ft;
          return (
            <button
              key={ft}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!store[ft]}
              onClick={() => setType(ft)}
              className={`rounded-[14px] px-3 py-2.5 text-center transition-[background-color,box-shadow,color] disabled:cursor-not-allowed disabled:opacity-45 ${on ? "bg-white shadow-sm shadow-ink/10 ring-1 ring-line-soft" : "hover:bg-white/60"}`}
            >
              <span className={`block text-[15px] font-bold ${on ? "text-ink" : "text-ink-2"}`}>
                {t(`shop.${ft}`)}
              </span>
              <span className="block text-[12px] text-muted">{sub(ft)}</span>
            </button>
          );
        })}
      </div>
      <div className="rp-fade mt-2.5 px-1 text-[13px] leading-relaxed text-ink-2" key={type ?? ""}>
        {type === "pickup" && store.pickup && (
          <p className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span className="font-semibold text-ink">
              {nextSlot
                ? t("customer.online.nextPickup", {
                    time: `${dayLabel(t, nextSlot, tz, locale)} ${formatTime(nextSlot, locale, tz)}`,
                  })
                : t("shop.noSlots")}
            </span>
            <span className="text-muted">{t("paymentMethod.pay_on_pickup")}</span>
          </p>
        )}
        {type === "delivery" && store.delivery && (
          <>
            <ul className="flex flex-wrap gap-1.5">
              {fees.map((f) => (
                <li
                  key={f.maxDistanceM}
                  className="rounded-full bg-panel px-2.5 py-1 text-[12px] tabular-nums ring-1 ring-line-soft"
                >
                  {t("customer.online.upToKm", { km: (f.maxDistanceM / 1000).toFixed(1) })}{" "}
                  <span className="font-bold text-ink">
                    {f.feeYen === 0 ? t("shop.free") : formatYen(f.feeYen, locale)}
                  </span>
                  {f.minOrderYen > 0 &&
                    ` · ${t("customer.online.minShort", { amount: formatYen(f.minOrderYen, locale) })}`}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[12px] text-muted">
              {t("customer.online.addressChecked")} {t("paymentMethod.cash_on_delivery")}
            </p>
          </>
        )}
        {type === null && <p className="text-muted">{t("shop.unavailable")}</p>}
      </div>
    </section>
  );
}

function FeaturedRail({
  items,
  canOrder,
  quantityOf,
  onOpen,
  onQuickAdd,
}: {
  items: CustomerMenuItem[];
  canOrder: boolean;
  quantityOf: (id: string) => number;
  onOpen: (i: CustomerMenuItem) => void;
  onQuickAdd: (i: CustomerMenuItem) => void;
}) {
  const t = useTranslations("customer");
  const locale = useLocale();
  return (
    <section aria-labelledby="featured" className="pt-7">
      <h2 id="featured" className="px-4 text-[18px] font-bold tracking-tight sm:px-6">
        {t("online.featured")}
      </h2>
      <ul className="mt-3 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:scroll-px-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
        {items.map((i) => {
          const name = pickName(i.name, locale);
          const inCart = quantityOf(i.id);
          return (
            <li key={i.id} className="group relative w-[156px] shrink-0 snap-start sm:w-[176px]">
              <button
                type="button"
                onClick={() => onOpen(i)}
                aria-label={t("openItem", { name })}
                className="block w-full text-left"
              >
                <span className="relative block">
                  <MenuItemImage
                    image={i.image}
                    name={name}
                    placeholder="neutral"
                    className={`aspect-square w-full rounded-[18px] motion-safe:[&_img]:group-hover:scale-[1.04] ${i.isAvailable ? "" : "grayscale"}`}
                    letterClassName="text-[40px]"
                  />
                  {!i.isAvailable && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-[18px] bg-ink/45">
                      <span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-ink">
                        {t("soldOut")}
                      </span>
                    </span>
                  )}
                </span>
                <span className="mt-2.5 line-clamp-2 block min-h-[2.5em] text-[14px] leading-snug font-bold break-words [word-break:auto-phrase]">
                  {name}
                </span>
                <span className="mt-1 block text-[15px] font-bold tabular-nums">
                  {formatYen(i.priceYen, locale)}
                </span>
              </button>
              {canOrder && i.isAvailable && (
                <button
                  type="button"
                  onClick={() => onQuickAdd(i)}
                  aria-label={t("quickAdd", { name })}
                  className={`absolute top-2 right-2 flex size-9 items-center justify-center rounded-full shadow-md shadow-ink/20 transition-[transform,background-color] hover:-translate-y-0.5 active:scale-90 ${inCart > 0 ? "bg-brand text-white" : "bg-white text-brand"}`}
                >
                  {inCart > 0 ? (
                    <span key={inCart} className="rp-pop text-[13px] font-bold tabular-nums">
                      {inCart}
                    </span>
                  ) : (
                    <Icon.Plus className="size-[18px]" />
                  )}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StoreFooter({ store }: { store: StorefrontResponse }) {
  const t = useTranslations("customer");
  const b = store.brand;
  if (!b.supportEmail && !b.supportPhone) return null;
  return (
    <footer className="mt-10 border-t border-line-soft px-4 pt-5 text-[12px] text-muted sm:px-6">
      <p>
        {t("online.support")} {b.supportPhone && <span className="mr-3">{b.supportPhone}</span>}
        {b.supportEmail && (
          <a href={`mailto:${b.supportEmail}`} className="underline">
            {b.supportEmail}
          </a>
        )}
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------- checkout

function Checkout({
  store,
  name,
  cart,
  type,
  setType,
  slot,
  setSlot,
  address,
  setAddress,
  contact,
  setContact,
  quote,
  busy,
  message,
  onQuote,
  onPlace,
  onBack,
}: {
  store: StorefrontResponse;
  name: string;
  cart: ReturnType<typeof useCart>;
  type: FulfillmentType | null;
  setType: (t: FulfillmentType) => void;
  slot: string | null;
  setSlot: (s: string) => void;
  address: DeliveryAddressInput;
  setAddress: (a: DeliveryAddressInput) => void;
  contact: { name: string; phone: string; email: string };
  setContact: (c: { name: string; phone: string; email: string }) => void;
  quote: OnlineQuoteDto | null;
  busy: "quote" | "order" | null;
  message: string | null;
  onQuote: () => void;
  onPlace: () => void;
  onBack: () => void;
}) {
  const t = useTranslations();
  const tc = useTranslations("customer");
  const locale = useLocale();
  const tz = store.location.timeZone;
  const note =
    locale === "en" ? (store.checkoutNote?.en ?? store.checkoutNote?.ja) : store.checkoutNote?.ja;
  const p = store.profile;
  const branchAddress = locale === "en" ? (p.address.en ?? p.address.ja) : p.address.ja;
  const contactOk =
    contact.name.trim().length > 0 && contact.phone.replace(/[^0-9]/g, "").length >= 10;
  const addressOk =
    type !== "delivery" ||
    (address.postalCode.trim().length >= 7 &&
      !!address.prefecture.trim() &&
      !!address.city.trim() &&
      !!address.line1.trim());
  const blockedByCart = cart.problems.length > 0 || cart.orderLines.length === 0;
  const ready =
    store.state === "open" &&
    !!quote &&
    quote.meetsMinimum &&
    contactOk &&
    addressOk &&
    !blockedByCart &&
    (type !== "pickup" || !!slot);
  const missing =
    type === "delivery" && !quote
      ? tc("online.needAddressCheck")
      : !contactOk
        ? tc("online.needContact")
        : null;
  const set = (patch: Partial<DeliveryAddressInput>) => setAddress({ ...address, ...patch });

  return (
    <div className="mx-auto max-w-[1080px] px-4 pt-4 pb-44 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-6 lg:pt-6 lg:pb-12">
      <div className="min-w-0 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-10 items-center gap-1 rounded-full bg-white pr-4 pl-2.5 text-[14px] font-semibold shadow-sm shadow-ink/5 ring-1 ring-line-soft transition-[background-color,transform] hover:bg-panel active:scale-95"
        >
          <Icon.Back className="size-[18px]" /> {tc("online.backToMenu")}
        </button>
        <h1 className="text-[26px] font-bold tracking-tight">{tc("online.checkoutTitle")}</h1>
        {message && <Banner>{message}</Banner>}
        {cart.problems.length > 0 && (
          <Banner>{tc("cartChanged", { count: cart.problems.length })}</Banner>
        )}

        <SectionCard step={1} id="co-receive" title={t("shop.howToReceive")}>
          <div
            role="radiogroup"
            aria-labelledby="co-receive"
            className="grid grid-cols-2 gap-1 rounded-[16px] bg-chip p-1"
          >
            {(["pickup", "delivery"] as const).map((ft) => {
              const on = type === ft;
              return (
                <button
                  key={ft}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!store[ft]}
                  onClick={() => setType(ft)}
                  className={`rounded-[12px] px-3 py-2.5 text-left transition-[background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-45 ${on ? "bg-white shadow-sm shadow-ink/10 ring-1 ring-line-soft" : "hover:bg-white/60"}`}
                >
                  <span className="block text-[15px] font-bold">{t(`shop.${ft}`)}</span>
                  <span className="block text-[12px] text-muted">
                    {ft === "pickup" && store.pickup
                      ? t("customer.online.pickupShort", { minutes: store.pickup.prepMinutes })
                      : ft === "delivery" && store.delivery
                        ? t("customer.online.deliveryShort", {
                            km: (store.delivery.radiusM / 1000).toFixed(1),
                          })
                        : tc("online.notOffered")}
                  </span>
                </button>
              );
            })}
          </div>

          {type === "pickup" && store.pickup && (
            <div className="rp-fade mt-4 space-y-4">
              <div className="flex gap-3 rounded-[14px] bg-panel px-4 py-3 ring-1 ring-line-soft">
                <Icon.Pin className="mt-0.5 size-5 shrink-0 text-muted" />
                <div className="min-w-0 text-[14px]">
                  <p className="font-bold">{tc("online.pickupAt", { name })}</p>
                  {store.profile.displayName && <p className="text-ink-2">{store.location.name}</p>}
                  {branchAddress && <p className="text-ink-2">{branchAddress}</p>}
                </div>
              </div>
              <label className="block text-[13px] font-semibold text-ink-2">
                {t("shop.pickupTime")}
                {store.pickup.slots.length === 0 ? (
                  <p className="mt-1 text-[14px] font-normal text-muted">{t("shop.noSlots")}</p>
                ) : (
                  <span className="relative mt-1.5 block">
                    <select
                      value={slot ?? ""}
                      onChange={(e) => setSlot(e.target.value)}
                      className="h-12 w-full appearance-none rounded-[12px] border border-line bg-white pr-10 pl-3.5 text-[16px] font-semibold text-ink focus:border-ink"
                    >
                      {store.pickup.slots.map((s) => (
                        <option key={s} value={s}>
                          {dayLabel(t, s, tz, locale)} {formatTime(s, locale, tz)}
                        </option>
                      ))}
                    </select>
                    <Icon.Chevron className="pointer-events-none absolute top-1/2 right-3.5 size-5 -translate-y-1/2 text-muted" />
                  </span>
                )}
              </label>
              <p className="text-[12px] leading-relaxed text-muted">
                {tc("online.pickupInstructions")}
              </p>
            </div>
          )}

          {type === "delivery" && store.delivery && (
            <fieldset className="rp-fade mt-4 space-y-3">
              <legend className="mb-2 text-[14px] font-bold">{t("shop.address")}</legend>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-[140px_1fr_1fr]">
                <Field
                  label={t("shop.postalCode")}
                  value={address.postalCode}
                  autoComplete="postal-code"
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="150-0002"
                  required
                  className="col-span-2 sm:col-span-1"
                  onChange={(v) => set({ postalCode: v })}
                />
                <Field
                  label={t("shop.prefecture")}
                  value={address.prefecture}
                  autoComplete="address-level1"
                  maxLength={10}
                  required
                  onChange={(v) => set({ prefecture: v })}
                />
                <Field
                  label={t("shop.city")}
                  value={address.city}
                  autoComplete="address-level2"
                  maxLength={60}
                  required
                  onChange={(v) => set({ city: v })}
                />
              </div>
              <Field
                label={t("shop.line1")}
                value={address.line1}
                autoComplete="address-line1"
                maxLength={120}
                required
                onChange={(v) => set({ line1: v })}
              />
              <Field
                label={t("shop.line2")}
                value={address.line2 ?? ""}
                autoComplete="address-line2"
                maxLength={120}
                onChange={(v) => set({ line2: v })}
              />
              <Field
                label={t("shop.instructions")}
                value={address.instructions ?? ""}
                maxLength={200}
                onChange={(v) => set({ instructions: v })}
              />
              <button
                type="button"
                disabled={busy !== null || !addressOk || blockedByCart}
                onClick={onQuote}
                className={`${secondaryButton} ring-2 ring-ink`}
              >
                {busy === "quote" && <Spinner />}
                {t("shop.checkAddress")}
              </button>
              <p className="text-[12px] text-muted">{t("shop.distanceNote")}</p>
              {quote && quote.deliveryDistanceM !== null && (
                <p
                  role="status"
                  className="rp-fade flex items-start gap-2 rounded-[14px] bg-green-50 px-4 py-3 text-[14px] font-semibold text-ok"
                >
                  <Icon.Check className="mt-0.5 size-4 shrink-0" />
                  {tc("online.deliverable", {
                    km: (quote.deliveryDistanceM / 1000).toFixed(1),
                    fee:
                      quote.deliveryFeeYen === 0
                        ? t("shop.free")
                        : formatYen(quote.deliveryFeeYen, locale),
                  })}
                </p>
              )}
            </fieldset>
          )}
        </SectionCard>

        <SectionCard step={2} id="co-contact" title={t("shop.contact")}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t("shop.name")}
              value={contact.name}
              autoComplete="name"
              maxLength={60}
              required
              onChange={(v) => setContact({ ...contact, name: v })}
            />
            <Field
              label={t("shop.phone")}
              value={contact.phone}
              autoComplete="tel"
              inputMode="tel"
              maxLength={20}
              required
              placeholder="090-1234-5678"
              onChange={(v) => setContact({ ...contact, phone: v })}
            />
          </div>
          <p className="mt-1.5 text-[12px] text-muted">{t("shop.phoneHint")}</p>
          <div className="mt-3">
            <Field
              label={t("shop.email")}
              value={contact.email}
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              onChange={(v) => setContact({ ...contact, email: v })}
            />
          </div>
        </SectionCard>

        <SectionCard step={3} id="co-pay" title={t("shop.paymentMethod")}>
          <p className="flex items-center gap-3 rounded-[14px] bg-white px-4 py-3.5 text-[15px] font-bold ring-2 ring-ink">
            <span aria-hidden className="size-[18px] rounded-full border-[5px] border-ink" />
            {type
              ? t(`paymentMethod.${type === "pickup" ? "pay_on_pickup" : "cash_on_delivery"}`)
              : "—"}
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">{tc("online.paymentNote")}</p>
        </SectionCard>
        {note && <Banner tone="info">{note}</Banner>}
      </div>

      <aside className="mt-4 lg:sticky lg:top-[calc(var(--header-h)+24px)] lg:mt-0">
        <SectionCard
          id="co-summary"
          title={t("shop.review")}
          action={
            <button
              type="button"
              onClick={onBack}
              className="rounded-full px-2.5 py-1.5 text-[13px] font-bold text-brand-dark transition-colors hover:bg-brand-tint"
            >
              {tc("online.editOrder")}
            </button>
          }
        >
          <ul className="space-y-3">
            {cart.lines
              .filter((l) => !l.problem && l.item)
              .map((l) => (
                <li key={l.key} className="flex gap-3">
                  <MenuItemImage
                    image={l.item?.image ?? null}
                    name={l.item ? pickName(l.item.name, locale) : ""}
                    placeholder="neutral"
                    className="size-11 rounded-[10px]"
                    letterClassName="text-[16px]"
                  />
                  <span className="min-w-0 flex-1 text-[14px] leading-snug break-words">
                    <span className="font-semibold">
                      {l.item ? pickName(l.item.name, locale) : ""}
                    </span>
                    <span className="ml-1.5 font-bold text-muted tabular-nums">×{l.quantity}</span>
                    {l.note.trim() && (
                      <span className="mt-0.5 block text-[12px] text-muted">{l.note.trim()}</span>
                    )}
                  </span>
                  <span className="text-[14px] font-semibold tabular-nums">
                    {formatYen((l.item?.priceYen ?? 0) * l.quantity, locale)}
                  </span>
                </li>
              ))}
          </ul>
          <div className="mt-4 border-t border-line pt-3">
            {quote ? (
              <dl className="rp-fade space-y-1.5 text-[14px]">
                <Row
                  label={t("shop.itemsSubtotal")}
                  value={formatYen(quote.itemsSubtotalYen, locale)}
                />
                {type === "delivery" && (
                  <Row
                    label={t("shop.deliveryFee")}
                    value={
                      quote.deliveryFeeYen === 0
                        ? t("shop.free")
                        : formatYen(quote.deliveryFeeYen, locale)
                    }
                  />
                )}
                {quote.taxBreakdown.map((x) => (
                  <Row
                    key={x.rateBp}
                    muted
                    label={
                      quote.pricesIncludeTax
                        ? t("shop.taxIncluded", { rate: ratePercent(x.rateBp) })
                        : t("shop.tax", { rate: ratePercent(x.rateBp) })
                    }
                    value={formatYen(x.taxYen, locale)}
                  />
                ))}
                <div className="flex items-baseline justify-between border-t border-line-soft pt-2.5">
                  <dt className="text-[15px] font-bold">{t("shop.total")}</dt>
                  <dd className="text-[24px] font-bold tabular-nums">
                    {formatYen(quote.totalYen, locale)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="flex items-center gap-2 text-[14px] text-muted">
                {busy === "quote" && <Spinner />}
                {busy === "quote"
                  ? tc("online.calculating")
                  : type === "delivery"
                    ? tc("online.needAddressCheck")
                    : tc("online.totalPending")}
              </p>
            )}
            {quote && !quote.meetsMinimum && (
              <p className="mt-2 text-[13px] font-bold text-brand-dark">
                {t("shop.minimum", { amount: formatYen(quote.minimumYen, locale) })}
              </p>
            )}
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-muted">{t("shop.privacy")}</p>
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line-soft bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <button
              type="button"
              disabled={busy !== null || !ready}
              onClick={onPlace}
              className={`${primaryButton} mx-auto max-w-[560px]`}
            >
              {busy === "order" && <Spinner light />}
              <span>{busy === "order" ? t("shop.placing") : t("shop.placeOrder")}</span>
              {quote && busy !== "order" && (
                <span className="tabular-nums opacity-90">
                  · {formatYen(quote.totalYen, locale)}
                </span>
              )}
            </button>
            {!ready && missing && busy === null && (
              <p className="mt-1.5 text-center text-[12px] text-muted">{missing}</p>
            )}
          </div>
        </SectionCard>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  className = "",
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  autoComplete?: string;
  inputMode?: "numeric" | "tel" | "email";
  maxLength?: number;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className={`block text-[13px] font-semibold text-ink-2 ${className}`}>
      {label}
      {rest.required && (
        <span aria-hidden className="ml-0.5 text-brand-dark">
          *
        </span>
      )}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        className="mt-1.5 h-12 w-full rounded-[12px] border border-line bg-white px-3.5 text-[16px] font-normal text-ink transition-colors placeholder:text-placeholder hover:border-ink-2/40 focus:border-ink"
      />
    </label>
  );
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${muted ? "text-muted" : "text-ink-2"}`}>
      <dt>{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}
