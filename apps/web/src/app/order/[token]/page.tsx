"use client";
/**
 * Public online-ordering storefront (pickup / delivery), styled like the approved guest menu. No account.
 * Every amount shown before the review step is a preview; the review step shows the SERVER quote (prices, delivery fee
 * from the server-checked address, tax), and the order is submitted with that reviewed total for comparison only.
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
import { LangToggle } from "../../../components/LangToggle";
import { Banner, Spinner, Stepper } from "../../../components/ui";
import { loadRecentOrder, saveRecentOrder } from "../../../features/online/recent";
import { ApiError, newIdempotencyKey, publicRequest } from "../../../lib/api";
import { formatTime, formatYen, pickName, ratePercent } from "../../../lib/format";

type MenuItem = StorefrontResponse["menu"][number]["items"][number];
interface CartLine {
  key: string;
  item: MenuItem;
  quantity: number;
  note: string;
}

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

function errorText(t: ReturnType<typeof useTranslations>, err: unknown): string {
  if (err instanceof ApiError && SHOP_ERRORS.has(err.code)) return t(`shopErrors.${err.code}`);
  if (err instanceof ApiError && err.status === 0) return t("errors.network");
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

export default function StorefrontPage() {
  const { token } = useParams<{ token: string }>();
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [store, setStore] = useState<StorefrontResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [view, setView] = useState<"menu" | "cart" | "checkout">("menu");
  const [type, setType] = useState<FulfillmentType | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [address, setAddress] = useState<DeliveryAddressInput>(emptyAddress);
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [quote, setQuote] = useState<OnlineQuoteDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orderKey = useRef(newIdempotencyKey());
  const [recent, setRecent] = useState<{ token: string; orderNo: number } | null>(null);

  const loadStore = useCallback(() => {
    publicRequest<StorefrontResponse>("GET", `/public/stores/${token}`)
      .then((s) => {
        setStore(s);
        setCategory((c) => c ?? s.menu[0]?.id ?? null);
        setType((ty) => ty ?? (s.pickup ? "pickup" : s.delivery ? "delivery" : null));
        setSlot((cur) =>
          cur && s.pickup?.slots.includes(cur) ? cur : (s.pickup?.slots[0] ?? null),
        );
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400))
          setNotFound(true);
        else setMessage(errorText(t, err));
      });
  }, [token, t]);
  useEffect(loadStore, [loadStore]);
  useEffect(() => {
    setRecent(loadRecentOrder(token));
  }, [token]);

  const items = useMemo(
    () => store?.menu.find((c) => c.id === category)?.items ?? [],
    [store, category],
  );
  const count = cart.reduce((s, l) => s + l.quantity, 0);
  const preview = cart.reduce((s, l) => s + l.item.priceYen * l.quantity, 0);
  const lines = cart.map((l) => ({
    menuItemId: l.item.id,
    quantity: l.quantity,
    note: l.note.trim() || null,
  }));
  const canOrder = store?.state === "open";

  const add = (item: MenuItem) => {
    if (!item.isAvailable) return;
    setQuote(null);
    setCart((c) => {
      const plain = c.find((l) => l.item.id === item.id && l.note === "");
      if (plain)
        return c.map((l) => (l === plain ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l));
      return [...c, { key: crypto.randomUUID(), item, quantity: 1, note: "" }];
    });
  };
  const update = (key: string, patch: Partial<CartLine>) => {
    setQuote(null);
    setCart((c) =>
      c.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.quantity > 0),
    );
  };
  const split = (key: string) =>
    setCart((c) =>
      c.flatMap((l) =>
        l.key === key && l.quantity > 1
          ? [
              { ...l, quantity: l.quantity - 1 },
              { key: crypto.randomUUID(), item: l.item, quantity: 1, note: "" },
            ]
          : [l],
      ),
    );

  async function requestQuote() {
    if (!type || cart.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      setQuote(
        await publicRequest<OnlineQuoteDto>("POST", `/public/stores/${token}/quote`, {
          body: {
            fulfillmentType: type,
            items: lines,
            address: type === "delivery" ? address : null,
          },
        }),
      );
    } catch (err) {
      setQuote(null);
      setMessage(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }
  // Pickup has no address to check: quote as soon as the checkout opens or the cart changes.
  // Attempted once per (type, cart) signature, so a failing quote never retries in a loop.
  const quotedFor = useRef<string | null>(null);
  const signature = `${type ?? ""}|${JSON.stringify(lines)}`;
  useEffect(() => {
    if (view !== "checkout" || type !== "pickup" || quote || cart.length === 0) return;
    if (quotedFor.current === signature) return;
    quotedFor.current = signature;
    void requestQuote();
  }, [view, type, quote, cart.length, signature]); // requestQuote reads the latest cart/type

  async function placeOrder() {
    if (!quote || !type) return;
    setBusy(true);
    setMessage(null);
    try {
      const placed = await publicRequest<OnlineOrderPlacedDto>(
        "POST",
        `/public/stores/${token}/orders`,
        {
          idempotencyKey: orderKey.current,
          body: {
            fulfillmentType: type,
            items: lines,
            ...(type === "pickup" ? { pickupTime: slot } : { address }),
            contact: {
              name: contact.name,
              phone: contact.phone,
              email: contact.email.trim() || null,
            },
            paymentMethod: type === "pickup" ? "pay_on_pickup" : "cash_on_delivery",
            expectedTotalYen: quote.totalYen,
          },
        },
      );
      saveRecentOrder(token, { token: placed.trackingToken, orderNo: placed.orderNo });
      orderKey.current = newIdempotencyKey();
      router.push(`/order/status#${placed.trackingToken}`);
    } catch (err) {
      setMessage(errorText(t, err));
      if (
        err instanceof ApiError &&
        (err.code === "total_changed" || err.code === "invalid_pickup_time")
      ) {
        setQuote(null);
        loadStore();
      }
    } finally {
      setBusy(false);
    }
  }

  if (notFound)
    return (
      <main className="p-6">
        <Banner>{t("shop.notFound")}</Banner>
      </main>
    );
  if (!store) return <Spinner label={t("common.loading")} />;

  const tz = store.location.timeZone;
  const stateBanner =
    store.state === "unavailable"
      ? t("shop.unavailable")
      : store.state === "paused"
        ? t("shop.paused")
        : store.state === "closed"
          ? t("shop.closed")
          : null;
  const note =
    locale === "en" ? (store.checkoutNote?.en ?? store.checkoutNote?.ja) : store.checkoutNote?.ja;
  const contactOk = contact.name.trim().length > 0 && contact.phone.trim().length >= 10;
  const addressOk =
    type !== "delivery" ||
    (address.postalCode.trim() &&
      address.prefecture.trim() &&
      address.city.trim() &&
      address.line1.trim());
  const ready =
    !!quote && quote.meetsMinimum && contactOk && !!addressOk && (type !== "pickup" || !!slot);

  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col bg-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line-2 bg-white px-4 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-bold">{store.location.name}</h1>
          <span className="mt-0.5 inline-block rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-white">
            {[store.pickup && t("shop.pickup"), store.delivery && t("shop.delivery")]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="ml-auto">
          <LangToggle />
        </div>
      </header>

      <main className="flex-1 pb-28">
        {stateBanner && (
          <div className="px-4 pt-3">
            <Banner tone="info">{stateBanner}</Banner>
          </div>
        )}
        {recent && view === "menu" && (
          <div className="px-4 pt-3">
            <a href={`/order/status#${recent.token}`} className="block">
              <Banner tone="ok">
                {t("shop.recentOrder", { no: String(recent.orderNo).padStart(4, "0") })} →
              </Banner>
            </a>
          </div>
        )}
        {message && (
          <div className="px-4 pt-3">
            <Banner>{message}</Banner>
          </div>
        )}

        {view === "menu" && (
          <>
            {store.hours.length > 0 && store.state !== "open" && <HoursList hours={store.hours} />}
            <nav className="flex gap-2 overflow-x-auto px-4 py-3" aria-label="categories">
              {store.menu.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={c.id === category}
                  onClick={() => setCategory(c.id)}
                  className={`h-11 shrink-0 rounded-full border px-4 text-[14px] font-semibold ${c.id === category ? "border-brand bg-brand text-white" : "border-line text-ink-2"}`}
                >
                  {pickName(c.name, locale)}
                </button>
              ))}
            </nav>
            <ul className="px-4">
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 border-b border-line-soft py-3">
                  <MenuItemImage
                    image={i.image}
                    name={pickName(i.name, locale)}
                    className="size-[72px] rounded-[12px]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-semibold">{pickName(i.name, locale)}</p>
                    {(locale === "en" ? i.description.en : i.description.ja) && (
                      <p className="text-[13px] text-muted">
                        {locale === "en" ? i.description.en : i.description.ja}
                      </p>
                    )}
                    <p className="text-[16px] font-bold">
                      {i.isAvailable ? formatYen(i.priceYen, locale) : t("shop.soldOut")}
                    </p>
                  </div>
                  {canOrder && (
                    <button
                      type="button"
                      disabled={!i.isAvailable}
                      onClick={() => add(i)}
                      aria-label={t("shop.add", { name: pickName(i.name, locale) })}
                      className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-[22px] text-white disabled:opacity-40"
                    >
                      +
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {view === "cart" && (
          <section className="px-4 pt-3">
            <h2 className="mb-2 text-[18px] font-bold">{t("shop.yourOrder")}</h2>
            {cart.length === 0 ? (
              <p className="text-[14px] text-muted">{t("shop.empty")}</p>
            ) : (
              cart.map((l) => (
                <div key={l.key} className="border-b border-line-soft py-3">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-[15px] font-semibold">
                      {pickName(l.item.name, locale)}
                    </p>
                    <Stepper
                      value={l.quantity}
                      onChange={(q) => update(l.key, { quantity: q })}
                      labels={{ dec: t("common.decrease"), inc: t("common.increase") }}
                    />
                  </div>
                  <input
                    value={l.note}
                    maxLength={140}
                    onChange={(e) => update(l.key, { note: e.target.value })}
                    placeholder={t("shop.notePlaceholder")}
                    aria-label={t("shop.notePlaceholder")}
                    className="mt-2 h-10 w-full rounded-[8px] border border-line bg-panel px-3 text-[14px]"
                  />
                  {l.quantity > 1 && (
                    <button
                      type="button"
                      onClick={() => split(l.key)}
                      className="mt-1 text-[12px] font-semibold text-brand"
                    >
                      + {t("shop.separateRequest")}
                    </button>
                  )}
                </div>
              ))
            )}
            <button
              type="button"
              disabled={cart.length === 0 || !canOrder}
              onClick={() => setView("checkout")}
              className="mt-4 h-14 w-full rounded-[14px] bg-ink text-[16px] font-semibold text-white disabled:opacity-50"
            >
              {t("shop.continue")}
            </button>
            <BackButton onClick={() => setView("menu")} />
          </section>
        )}

        {view === "checkout" && (
          <section className="space-y-5 px-4 pt-3">
            <div>
              <h2 className="mb-2 text-[18px] font-bold">{t("shop.howToReceive")}</h2>
              <div className="grid grid-cols-2 gap-2">
                {(["pickup", "delivery"] as const).map((ft) => {
                  const avail = ft === "pickup" ? store.pickup : store.delivery;
                  return (
                    <button
                      key={ft}
                      type="button"
                      disabled={!avail}
                      aria-pressed={type === ft}
                      onClick={() => {
                        setType(ft);
                        setQuote(null);
                        setMessage(null);
                      }}
                      className={`rounded-[14px] border-2 p-3 text-left disabled:opacity-40 ${type === ft ? "border-brand bg-brand-tint" : "border-line"}`}
                    >
                      <span className="block text-[16px] font-bold">{t(`shop.${ft}`)}</span>
                      <span className="block text-[12px] text-muted">
                        {ft === "pickup" && store.pickup
                          ? t("shop.pickupInfo", { minutes: store.pickup.prepMinutes })
                          : store.delivery
                            ? t("shop.deliveryInfo", {
                                km: (store.delivery.radiusM / 1000).toFixed(1),
                              })
                            : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {type === "pickup" && store.pickup && (
              <label className="block text-[14px] font-semibold">
                {t("shop.pickupTime")}
                {store.pickup.slots.length === 0 ? (
                  <p className="mt-1 font-normal text-muted">{t("shop.noSlots")}</p>
                ) : (
                  <select
                    value={slot ?? ""}
                    onChange={(e) => setSlot(e.target.value)}
                    className="mt-1 h-12 w-full rounded-[10px] border border-line px-3 font-normal"
                  >
                    {store.pickup.slots.map((s) => (
                      <option key={s} value={s}>
                        {dayLabel(t, s, tz)} {formatTime(s, locale, tz)}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            {type === "delivery" && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-[16px] font-bold">{t("shop.address")}</legend>
                <Field
                  label={t("shop.postalCode")}
                  value={address.postalCode}
                  autoComplete="postal-code"
                  inputMode="numeric"
                  maxLength={10}
                  onChange={(v) => {
                    setAddress({ ...address, postalCode: v });
                    setQuote(null);
                  }}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Field
                    label={t("shop.prefecture")}
                    value={address.prefecture}
                    autoComplete="address-level1"
                    maxLength={10}
                    onChange={(v) => {
                      setAddress({ ...address, prefecture: v });
                      setQuote(null);
                    }}
                  />
                  <Field
                    label={t("shop.city")}
                    value={address.city}
                    autoComplete="address-level2"
                    maxLength={60}
                    onChange={(v) => {
                      setAddress({ ...address, city: v });
                      setQuote(null);
                    }}
                  />
                </div>
                <Field
                  label={t("shop.line1")}
                  value={address.line1}
                  autoComplete="address-line1"
                  maxLength={120}
                  onChange={(v) => {
                    setAddress({ ...address, line1: v });
                    setQuote(null);
                  }}
                />
                <Field
                  label={t("shop.line2")}
                  value={address.line2 ?? ""}
                  autoComplete="address-line2"
                  maxLength={120}
                  onChange={(v) => setAddress({ ...address, line2: v })}
                />
                <Field
                  label={t("shop.instructions")}
                  value={address.instructions ?? ""}
                  maxLength={200}
                  onChange={(v) => setAddress({ ...address, instructions: v })}
                />
                <p className="text-[12px] text-muted">{t("shop.distanceNote")}</p>
                <button
                  type="button"
                  disabled={busy || !addressOk}
                  onClick={() => void requestQuote()}
                  className="h-12 w-full rounded-[12px] border border-ink text-[15px] font-semibold disabled:opacity-40"
                >
                  {t("shop.checkAddress")}
                </button>
              </fieldset>
            )}

            <fieldset className="space-y-2">
              <legend className="mb-1 text-[16px] font-bold">{t("shop.contact")}</legend>
              <Field
                label={t("shop.name")}
                value={contact.name}
                autoComplete="name"
                maxLength={60}
                onChange={(v) => setContact({ ...contact, name: v })}
              />
              <Field
                label={t("shop.phone")}
                value={contact.phone}
                autoComplete="tel"
                inputMode="tel"
                maxLength={20}
                onChange={(v) => setContact({ ...contact, phone: v })}
              />
              <p className="text-[12px] text-muted">{t("shop.phoneHint")}</p>
              <Field
                label={t("shop.email")}
                value={contact.email}
                autoComplete="email"
                inputMode="email"
                maxLength={254}
                onChange={(v) => setContact({ ...contact, email: v })}
              />
            </fieldset>

            {quote && (
              <section className="rounded-[14px] border border-line p-4">
                <h2 className="mb-2 text-[16px] font-bold">{t("shop.review")}</h2>
                <ul className="mb-2 space-y-1 text-[14px]">
                  {cart.map((l) => (
                    <li key={l.key} className="flex gap-2">
                      <span className="font-semibold">×{l.quantity}</span>
                      <span className="min-w-0 flex-1">
                        {pickName(l.item.name, locale)}
                        {l.note.trim() && (
                          <span className="block text-[12px] text-muted">{l.note.trim()}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <dl className="space-y-1 border-t border-line pt-2 text-[14px]">
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
                  <div className="flex justify-between pt-1 text-[18px] font-bold">
                    <dt>{t("shop.total")}</dt>
                    <dd>{formatYen(quote.totalYen, locale)}</dd>
                  </div>
                  <Row
                    label={t("shop.paymentMethod")}
                    value={t(
                      `paymentMethod.${type === "pickup" ? "pay_on_pickup" : "cash_on_delivery"}`,
                    )}
                  />
                </dl>
                {!quote.meetsMinimum && (
                  <p className="mt-2 text-[13px] font-semibold text-brand-dark">
                    {t("shop.minimum", { amount: formatYen(quote.minimumYen, locale) })}
                  </p>
                )}
              </section>
            )}
            {note && <Banner tone="info">{note}</Banner>}
            <p className="text-[12px] text-muted">{t("shop.privacy")}</p>
            <button
              type="button"
              disabled={busy || !ready || !canOrder}
              onClick={() => void placeOrder()}
              className="h-14 w-full rounded-[14px] bg-brand text-[16px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? t("shop.placing") : t("shop.placeOrder")}
            </button>
            <BackButton onClick={() => setView("cart")} />
          </section>
        )}
      </main>

      {canOrder && view === "menu" && count > 0 && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-[480px] p-4">
          <button
            type="button"
            onClick={() => setView("cart")}
            className="flex h-14 w-full items-center justify-between rounded-[14px] bg-ink px-5 text-[16px] font-semibold text-white"
          >
            <span>{t("shop.viewCart", { count })}</span>
            <span>{formatYen(preview, locale)}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function dayLabel(t: ReturnType<typeof useTranslations>, iso: string, tz: string): string {
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const day = fmt(new Date(iso));
  if (day === fmt(new Date())) return t("shop.today");
  if (day === fmt(new Date(Date.now() + 86_400_000))) return t("shop.tomorrow");
  return day;
}

function HoursList({ hours }: { hours: StorefrontResponse["hours"] }) {
  const t = useTranslations();
  return (
    <section className="mx-4 mt-3 rounded-[12px] bg-panel p-3 text-[13px]">
      <h2 className="mb-1 font-semibold">{t("shop.hours")}</h2>
      <ul className="grid grid-cols-2 gap-x-3">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const w = hours.filter((h) => h.weekday === d);
          return (
            <li key={d}>
              <span className="inline-block w-8 font-semibold">{t(`weekdays.${String(d)}`)}</span>
              {w.length === 0 ? "—" : w.map((h) => `${h.opensAt}–${h.closesAt}`).join(", ")}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  inputMode?: "numeric" | "tel" | "email";
  maxLength?: number;
}) {
  return (
    <label className="block text-[13px] font-medium text-ink-2">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        className="mt-1 h-12 w-full rounded-[10px] border border-line px-3 text-[15px] text-ink"
      />
    </label>
  );
}

function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${muted ? "text-muted" : ""}`}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 h-12 w-full text-[14px] font-semibold text-ink-2"
    >
      {t("shop.back")}
    </button>
  );
}
