/**
 * Public online-ordering storefront (no account): store view, server-side quote, order submission, order tracking and
 * customer cancellation. Exposes only public data; never staff, other customers' or financial-report data.
 */
import { sql } from "kysely";
import type { AppDeps } from "../../../app/deps.js";
import { type Tx, withTenantTransaction } from "../../../infrastructure/database/db.js";
import { withIdempotency } from "../../../infrastructure/database/idempotency.js";
import { sha256 } from "../../../infrastructure/security/tokens.js";
import { AppError, Errors } from "../../../shared/errors/app-error.js";
import type { CustomerContext } from "../../../shared/types/access-context.js";
import { recordAudit } from "../../audit/index.js";
import { type PublicBrand, getTenantBrand } from "../../branding/index.js";
import { type FeatureKey, resolveEntitlements } from "../../entitlements/index.js";
import { getMenu, getOrderableItems } from "../../menus/index.js";
import {
  type OrderLineInput,
  createOnlineOrder,
  getOrderItems,
  voidOrder,
} from "../../orders/index.js";
import { type LocationSettings, getLocationSettings } from "../../restaurants/index.js";
import { type FeeTier, cleanText, deliveryRadiusM, normalizePhone } from "../domain/delivery.js";
import { type HoursWindow, isOpenAt, pickupSlots } from "../domain/schedule.js";
import {
  type FulfillmentType,
  type OnlinePaymentMethod,
  paymentMethodFor,
  paymentStatusAfterCancellation,
} from "../domain/status.js";
import {
  type AddressInput,
  type OnlineTotals,
  type VerifiedAddress,
  computeOnlineTotals,
  deliveryFeeTaxRateBp,
  deliveryTierFor,
  verifyAddress,
} from "./pricing.js";
import { emitOnlineEvent, lockOnlineOrder, recordHistory, toRow, transition } from "./records.js";
import {
  type OnlineSettings,
  getHours,
  getSettings,
  getTiers,
  resolveStoreLink,
} from "./settings.js";
import { issueTrackingToken } from "./tracking.js";

const MAX_PENDING_PER_PHONE = 3;
const MAX_PENDING_PER_LOCATION = 100;

export type StoreState = "open" | "paused" | "closed" | "unavailable";

interface StoreContext {
  tenantId: string;
  locationId: string;
  location: LocationSettings;
  brand: PublicBrand;
  settings: OnlineSettings;
  hours: HoursWindow[];
  tiers: FeeTier[];
  features: ReadonlySet<FeatureKey>;
}

async function loadStore(
  tx: Tx,
  ref: { tenantId: string; locationId: string },
): Promise<StoreContext> {
  const [location, brand, settings, hours, tiers, ent] = await Promise.all([
    getLocationSettings(tx, ref.locationId),
    getTenantBrand(tx, ref.tenantId),
    getSettings(tx, ref.locationId),
    getHours(tx, ref.locationId),
    getTiers(tx, ref.locationId),
    resolveEntitlements(tx, ref.locationId),
  ]);
  return { ...ref, location, brand, settings, hours, tiers, features: ent.features };
}

function availability(store: StoreContext, geocoderEnabled: boolean, now: Date) {
  const s = store.settings;
  const active = store.features.has("online_ordering") && s.enabled;
  const pickup =
    active && store.features.has("pickup_ordering") && s.pickupEnabled && s.payAtHandoverEnabled;
  const delivery =
    active &&
    store.features.has("delivery_management") &&
    s.deliveryEnabled &&
    s.payAtHandoverEnabled &&
    geocoderEnabled &&
    s.storeLocation !== null &&
    store.tiers.length > 0;
  const openNow = isOpenAt(store.hours, now, store.location.timeZone);
  const state: StoreState =
    !active || (!pickup && !delivery)
      ? "unavailable"
      : s.paused
        ? "paused"
        : openNow
          ? "open"
          : "closed";
  return { state, pickup, delivery };
}

function slotsFor(store: StoreContext, now: Date): Date[] {
  return pickupSlots({
    windows: store.hours,
    now,
    timeZone: store.location.timeZone,
    prepMinutes: store.settings.pickupPrepMinutes,
    slotMinutes: store.settings.pickupSlotMinutes,
    daysAhead: store.settings.pickupDaysAhead,
  });
}

/** Fails with the precise reason a new order of this type cannot be accepted right now. */
function assertCanOrder(
  store: StoreContext,
  type: FulfillmentType,
  geocoderEnabled: boolean,
  now: Date,
) {
  if (!store.features.has("online_ordering")) throw Errors.notEntitled("online_ordering");
  if (type === "pickup" && !store.features.has("pickup_ordering"))
    throw Errors.notEntitled("pickup_ordering");
  if (type === "delivery" && !store.features.has("delivery_management"))
    throw Errors.notEntitled("delivery_management");
  const a = availability(store, geocoderEnabled, now);
  if (a.state === "unavailable")
    throw Errors.conflict("ordering_unavailable", "Online ordering is not available");
  if (a.state === "paused") throw Errors.conflict("ordering_paused", "New orders are paused");
  if (a.state === "closed")
    throw Errors.conflict("store_closed", "The store is not taking orders now");
  if (type === "pickup" && !a.pickup)
    throw Errors.conflict("fulfillment_unavailable", "Pickup is not available");
  if (type === "delivery" && !a.delivery)
    throw Errors.conflict("delivery_unavailable", "Delivery is not available right now");
}

/**
 * Cheap availability check BEFORE geocoding, so a disabled, paused, closed or non-entitled store never triggers
 * (possibly paid) provider calls. The order transaction re-checks everything authoritatively.
 */
async function precheck(
  deps: AppDeps,
  ref: { tenantId: string; locationId: string },
  type: FulfillmentType,
  now: Date,
): Promise<void> {
  await withTenantTransaction(deps.db, { tenantId: ref.tenantId }, async (tx) => {
    assertCanOrder(await loadStore(tx, ref), type, deps.geocoder.enabled, now);
  });
}

// ---------------------------------------------------------------- store view

export async function getStorefront(deps: AppDeps, token: string, now = new Date()) {
  const ref = await resolveStoreLink(deps.db, token);
  if (!ref) throw Errors.notFound("store");
  return withTenantTransaction(deps.db, { tenantId: ref.tenantId }, async (tx) => {
    const store = await loadStore(tx, ref);
    const a = availability(store, deps.geocoder.enabled, now);
    const base = {
      brand: store.brand,
      location: { name: store.location.name, timeZone: store.location.timeZone },
      state: a.state,
    };
    if (a.state === "unavailable")
      return { ...base, menu: [], pickup: null, delivery: null, hours: [] };
    const menu = await getMenu(tx, ref.locationId, { publicView: true, storage: deps.storage });
    return {
      ...base,
      hours: store.hours,
      minOrderYen: store.settings.minOrderYen,
      checkoutNote: store.settings.checkoutNote,
      pricesIncludeTax: store.location.pricesIncludeTax,
      pickup: a.pickup
        ? {
            prepMinutes: store.settings.pickupPrepMinutes,
            slots: a.state === "open" ? slotsFor(store, now).map((d) => d.toISOString()) : [],
            paymentMethod: "pay_on_pickup" as OnlinePaymentMethod,
          }
        : null,
      delivery: a.delivery
        ? {
            prepMinutes: store.settings.deliveryPrepMinutes,
            radiusM: deliveryRadiusM(store.tiers),
            tiers: store.tiers,
            distanceBasis: "straight_line" as const,
            paymentMethod: "cash_on_delivery" as OnlinePaymentMethod,
          }
        : null,
      menu: menu
        .map((c) => ({
          id: c.id,
          name: c.name,
          items: c.items.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description,
            priceYen: i.priceYen,
            isAvailable: i.isAvailable,
            image: i.image,
          })),
        }))
        .filter((c) => c.items.length > 0),
    };
  });
}

// ---------------------------------------------------------------- pricing (quote + submission share this)

interface PricedOrder {
  totals: OnlineTotals;
  delivery: { distanceM: number; feeYen: number; minOrderYen: number } | null;
  minimumYen: number;
}

async function priceOrder(
  tx: Tx,
  store: StoreContext,
  type: FulfillmentType,
  lines: readonly { unitPriceYen: number; quantity: number; taxRateBp: number }[],
  address: VerifiedAddress | null,
): Promise<PricedOrder> {
  let delivery: PricedOrder["delivery"] = null;
  let fee: { feeYen: number; taxRateBp: number } | null = null;
  if (type === "delivery") {
    if (!address) throw Errors.validation({ address: "required for delivery" });
    const { distanceM, tier } = deliveryTierFor(store.settings.storeLocation, store.tiers, address);
    delivery = { distanceM, feeYen: tier.feeYen, minOrderYen: tier.minOrderYen };
    fee = { feeYen: tier.feeYen, taxRateBp: await deliveryFeeTaxRateBp(tx, store.locationId) };
  }
  const totals = computeOnlineTotals(lines, fee, store.location);
  const minimumYen = Math.max(store.settings.minOrderYen, delivery?.minOrderYen ?? 0);
  return { totals, delivery, minimumYen };
}

function assertMinimum(priced: PricedOrder): void {
  if (priced.totals.itemsSubtotalYen < priced.minimumYen) {
    throw Errors.unprocessable("below_minimum_order", "The order is below the minimum amount", {
      minimumYen: priced.minimumYen,
      itemsSubtotalYen: priced.totals.itemsSubtotalYen,
    });
  }
}

export interface QuoteInput {
  fulfillmentType: FulfillmentType;
  items: OrderLineInput[];
  address?: AddressInput | null | undefined;
}

/** Server-side price check for the review screen. Creates nothing. */
export async function quoteOnlineOrder(
  deps: AppDeps,
  token: string,
  input: QuoteInput,
  now = new Date(),
) {
  const ref = await resolveStoreLink(deps.db, token);
  if (!ref) throw Errors.notFound("store");
  let address: VerifiedAddress | null = null;
  if (input.fulfillmentType === "delivery" && input.address) {
    await precheck(deps, ref, "delivery", now);
    address = await verifyAddress(deps.geocoder, input.address);
  }
  return withTenantTransaction(deps.db, { tenantId: ref.tenantId }, async (tx) => {
    const store = await loadStore(tx, ref);
    assertCanOrder(store, input.fulfillmentType, deps.geocoder.enabled, now);
    const menu = await getOrderableItems(
      tx,
      ref.locationId,
      input.items.map((i) => i.menuItemId),
      "takeout",
    );
    const lines = input.items.map((l) => {
      const m = menu.get(l.menuItemId);
      if (!m) throw Errors.unprocessable("item_not_found");
      return { unitPriceYen: m.priceYen, quantity: l.quantity, taxRateBp: m.taxRateBp };
    });
    const priced = await priceOrder(tx, store, input.fulfillmentType, lines, address);
    return {
      ...priced.totals,
      minimumYen: priced.minimumYen,
      meetsMinimum: priced.totals.itemsSubtotalYen >= priced.minimumYen,
      deliveryDistanceM: priced.delivery?.distanceM ?? null,
    };
  });
}

// ---------------------------------------------------------------- submission

export interface SubmitInput extends QuoteInput {
  pickupTime?: string | null | undefined;
  contact: { name: string; phone: string; email?: string | null | undefined };
  paymentMethod: OnlinePaymentMethod;
  /** The total the customer reviewed. Compared, never used as the amount. */
  expectedTotalYen: number;
}

export interface PlacedOnlineOrder {
  onlineOrderId: string;
  orderNo: number;
  status: string;
  fulfillmentType: FulfillmentType;
  scheduledFor: string;
  totalYen: number;
}

export function phoneRateKey(phone: string): string {
  return sha256(`phone:${phone}`).toString("base64url");
}

export function parseContactPhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) throw Errors.validation({ phone: "Enter a Japanese phone number" });
  return phone;
}

/**
 * Places an online order. All checks are server-side and inside ONE transaction with the inserts: entitlements,
 * store state (enabled / paused / open), pickup slot validity, delivery eligibility and fee (from the server-geocoded
 * address), item availability and prices, minimum order, spam caps, and the reviewed-total comparison.
 */
export async function submitOnlineOrder(
  deps: AppDeps,
  token: string,
  idempotencyKey: string,
  input: SubmitInput,
  meta: { ip: string | null; requestId: string },
  now = new Date(),
): Promise<PlacedOnlineOrder & { trackingToken: string; replayed: boolean }> {
  const ref = await resolveStoreLink(deps.db, token);
  if (!ref) throw Errors.notFound("store");
  const phone = parseContactPhone(input.contact.phone);
  const name = cleanText(input.contact.name, 60);
  if (!name) throw Errors.validation({ name: "required" });
  const email = cleanText(input.contact.email, 254);
  if (input.fulfillmentType === "delivery" && !input.address)
    throw Errors.validation({ address: "required for delivery" });
  // Geocode BEFORE the transaction (network I/O never holds database locks), and only for an open, entitled store.
  let address: VerifiedAddress | null = null;
  if (input.fulfillmentType === "delivery" && input.address) {
    await precheck(deps, ref, "delivery", now);
    address = await verifyAddress(deps.geocoder, input.address);
  }

  return withTenantTransaction(deps.db, { tenantId: ref.tenantId }, async (tx) => {
    const result = await withIdempotency(
      tx,
      {
        tenantId: ref.tenantId,
        scope: `online-order:${ref.locationId}`,
        key: idempotencyKey,
        request: input,
      },
      async () => {
        const store = await loadStore(tx, ref);
        assertCanOrder(store, input.fulfillmentType, deps.geocoder.enabled, now);
        if (input.paymentMethod !== paymentMethodFor(input.fulfillmentType))
          throw Errors.unprocessable(
            "payment_method_unavailable",
            "This payment method is not available",
          );
        await assertNotFlooding(tx, ref.locationId, phone);

        let scheduledFor: Date;
        if (input.fulfillmentType === "pickup") {
          const requested = input.pickupTime ? Date.parse(input.pickupTime) : Number.NaN;
          const slot = slotsFor(store, now).find((s) => s.getTime() === requested);
          if (!slot)
            throw Errors.unprocessable(
              "invalid_pickup_time",
              "Choose one of the available pickup times",
            );
          scheduledFor = slot;
        } else {
          scheduledFor = new Date(now.getTime() + store.settings.deliveryPrepMinutes * 60_000);
        }

        const source = input.fulfillmentType === "pickup" ? "ONLINE_PICKUP" : "ONLINE_DELIVERY";
        const record = await createOnlineOrder(tx, ref, source, input.items);
        const priced = await priceOrder(tx, store, input.fulfillmentType, record.items, address);
        assertMinimum(priced);
        if (priced.totals.totalYen !== input.expectedTotalYen) {
          throw Errors.conflict(
            "total_changed",
            "Prices or fees changed. Please review the order again.",
            {
              totalYen: priced.totals.totalYen,
            },
          );
        }

        const inserted = await tx
          .insertInto("online_orders")
          .values({
            tenant_id: ref.tenantId,
            location_id: ref.locationId,
            order_id: record.orderId,
            order_no: record.orderNo,
            fulfillment_type: input.fulfillmentType,
            payment_method: input.paymentMethod,
            scheduled_for: scheduledFor,
            items_subtotal_yen: priced.totals.itemsSubtotalYen,
            delivery_fee_yen: priced.totals.deliveryFeeYen,
            tax_total_yen: priced.totals.taxTotalYen,
            total_yen: priced.totals.totalYen,
            // node-pg would send a JS array as a Postgres array literal: serialize jsonb explicitly.
            tax_breakdown: sql<
              OnlineTotals["taxBreakdown"]
            >`${JSON.stringify(priced.totals.taxBreakdown)}::jsonb`,
            prices_include_tax: priced.totals.pricesIncludeTax,
            delivery_distance_m: priced.delivery?.distanceM ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const row = toRow(inserted);
        await tx
          .insertInto("online_order_contacts")
          .values({
            online_order_id: row.id,
            tenant_id: ref.tenantId,
            location_id: ref.locationId,
            name,
            phone,
            email,
            postal_code: address?.postalCode ?? null,
            prefecture: address?.prefecture ?? null,
            city: address?.city ?? null,
            address_line1: address?.line1 ?? null,
            address_line2: address?.line2 ?? null,
            delivery_instructions: address?.instructions ?? null,
            latitude: address?.location.latitude ?? null,
            longitude: address?.location.longitude ?? null,
            geocode_precision: address?.precision ?? null,
          })
          .execute();
        await recordHistory(
          tx,
          row,
          null,
          "pending_acceptance",
          { type: "customer", id: null },
          null,
        );
        await emitOnlineEvent(tx, row, "online.order.created");
        await recordAudit(
          tx,
          {
            kind: "customer",
            tenantId: ref.tenantId,
            locationId: ref.locationId,
            onlineOrderId: row.id,
            trackingTokenId: null,
            ...meta,
          },
          {
            action: "online_order.submitted",
            targetType: "online_order",
            targetId: row.id,
            metadata: {
              fulfillmentType: row.fulfillmentType,
              lines: record.items.length,
              totalYen: row.totalYen,
              distanceM: row.deliveryDistanceM,
            },
          },
        );
        const body: PlacedOnlineOrder = {
          onlineOrderId: row.id,
          orderNo: row.orderNo,
          status: row.status,
          fulfillmentType: row.fulfillmentType,
          scheduledFor: row.scheduledFor.toISOString(),
          totalYen: row.totalYen,
        };
        return { status: 201, body };
      },
    );
    // A fresh tracking token per response (replays included): raw tokens are never stored, not even for idempotency.
    const tracking = await issueTrackingToken(tx, {
      tenantId: ref.tenantId,
      locationId: ref.locationId,
      onlineOrderId: result.body.onlineOrderId,
      scheduledFor: new Date(result.body.scheduledFor),
    });
    return { ...result.body, trackingToken: tracking.token, replayed: result.replayed };
  });
}

async function assertNotFlooding(tx: Tx, locationId: string, phone: string): Promise<void> {
  const [byPhone, byLocation] = await Promise.all([
    tx
      .selectFrom("online_orders as o")
      .innerJoin("online_order_contacts as c", "c.online_order_id", "o.id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("o.location_id", "=", locationId)
      .where("c.phone", "=", phone)
      .where("o.status", "=", "pending_acceptance")
      .executeTakeFirstOrThrow(),
    tx
      .selectFrom("online_orders")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("location_id", "=", locationId)
      .where("status", "=", "pending_acceptance")
      .executeTakeFirstOrThrow(),
  ]);
  if (Number(byPhone.n) >= MAX_PENDING_PER_PHONE)
    throw new AppError(
      429,
      "too_many_pending_orders",
      "Please wait until your earlier orders are confirmed",
    );
  if (Number(byLocation.n) >= MAX_PENDING_PER_LOCATION)
    throw new AppError(429, "store_busy", "The store is very busy. Please try again shortly.");
}

// ---------------------------------------------------------------- customer tracking

export async function getTrackingView(deps: AppDeps, customer: CustomerContext) {
  const onlineOrderId = customer.onlineOrderId;
  if (!onlineOrderId) throw Errors.unauthenticated();
  return withTenantTransaction(deps.db, { tenantId: customer.tenantId }, async (tx) => {
    const r = await tx
      .selectFrom("online_orders")
      .selectAll()
      .where("id", "=", onlineOrderId)
      .executeTakeFirst();
    if (!r) throw Errors.notFound("online order");
    const row = toRow(r);
    const [location, brand, items] = await Promise.all([
      getLocationSettings(tx, row.locationId),
      getTenantBrand(tx, row.tenantId),
      getOrderItems(tx, row.orderId),
    ]);
    // Deliberately NO customer personal data (name, phone, address): the link may be forwarded.
    return {
      store: { name: location.name, timeZone: location.timeZone },
      brand,
      onlineOrderId: row.id,
      orderNo: row.orderNo,
      fulfillmentType: row.fulfillmentType,
      status: row.status,
      paymentMethod: row.paymentMethod,
      paymentStatus: row.paymentStatus,
      scheduledFor: row.scheduledFor,
      createdAt: row.createdAt,
      rejectionReason: row.rejectionReason,
      cancellationReason: row.cancellationReason,
      cancelledBy: row.cancelledBy,
      canCancel: row.status === "pending_acceptance",
      items: items.map((i) => ({
        id: i.id,
        nameJa: i.nameJa,
        nameEn: i.nameEn,
        quantity: i.quantity,
        note: i.note,
        unitPriceYen: i.unitPriceYen,
        lineTotalYen: i.lineTotalYen,
      })),
      totals: {
        itemsSubtotalYen: row.itemsSubtotalYen,
        deliveryFeeYen: row.deliveryFeeYen,
        taxBreakdown: row.taxBreakdown,
        taxTotalYen: row.taxTotalYen,
        totalYen: row.totalYen,
        pricesIncludeTax: row.pricesIncludeTax,
      },
    };
  });
}

/** A customer may cancel only while the restaurant has not accepted the order yet. */
export async function cancelByCustomer(deps: AppDeps, customer: CustomerContext): Promise<void> {
  const onlineOrderId = customer.onlineOrderId;
  if (!onlineOrderId) throw Errors.unauthenticated();
  await withTenantTransaction(deps.db, { tenantId: customer.tenantId }, async (tx) => {
    const row = await lockOnlineOrder(tx, customer.locationId, onlineOrderId);
    const next = await transition(
      tx,
      row,
      "cancel_by_customer",
      { type: "customer", id: null },
      {
        reason: "customer_request",
        cancellationReason: "customer_request",
        cancelledBy: "customer",
        paymentStatus: paymentStatusAfterCancellation(row.paymentStatus),
      },
    );
    await voidOrder(tx, {
      locationId: row.locationId,
      orderId: row.orderId,
      voidedBy: null,
      reason: "Cancelled by customer",
    });
    await recordAudit(tx, customer, {
      action: "online_order.cancelled_by_customer",
      targetType: "online_order",
      targetId: next.id,
    });
  });
}
