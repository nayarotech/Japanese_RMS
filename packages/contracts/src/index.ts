/**
 * @restaurant-platform/contracts: wire types shared by the web app and the API (JSON shapes; dates are ISO strings).
 * Identifiers only for features/permissions; the API decides what is allowed.
 */

export type Locale = "ja" | "en";
export type StaffRole = "owner" | "manager" | "cashier" | "waiter" | "kitchen";
export type OrderSource = "STAFF_POS" | "TABLE_QR" | "ONLINE_PICKUP" | "ONLINE_DELIVERY";
export type TableSessionStatus = "open" | "bill_requested" | "closed";
export type KitchenItemStatus = "queued" | "preparing" | "ready" | "served" | "voided";
export type KitchenTicketStatus = "new" | "preparing" | "ready" | "served" | "voided";

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

export interface PublicBrand {
  displayName: string;
  shortMark: string;
  primaryColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
}

export interface StaffSessionInfo {
  user: { id: string; displayName: string };
  role: StaffRole;
  permissions: string[];
  location: { id: string; name: string; timeZone: string };
  features: string[];
  brand: PublicBrand;
  csrfToken: string;
}

export interface LocalizedName {
  ja: string;
  en: string | null;
}

export interface MenuItemDto {
  id: string;
  categoryId: string;
  code: string | null;
  name: LocalizedName;
  description: { ja: string | null; en: string | null };
  priceYen: number;
  taxRateBp: number;
  taxRateId: string;
  /** Takeout/delivery tax rate (null = same as dine-in). */
  takeoutTaxRateId: string | null;
  takeoutTaxRateBp: number;
  isAvailable: boolean;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface MenuCategoryDto {
  id: string;
  name: LocalizedName;
  sortOrder: number;
  items: MenuItemDto[];
}

export interface StaffMenuResponse {
  categories: MenuCategoryDto[];
  taxRates: { id: string; code: string; rateBp: number }[];
}

export interface FloorTableDto {
  id: string;
  name: string;
  area: string | null;
  capacity: number;
  isActive: boolean;
  sortOrder: number;
  version: number;
  state: "free" | "occupied" | "bill_requested";
  session: {
    id: string;
    status: TableSessionStatus;
    guestCount: number;
    slipNo: number;
    openedAt: string;
    assignedWaiterId: string | null;
    subtotalYen: number;
    itemCount: number;
    readyCount: number;
  } | null;
}

export interface TableSessionDto {
  id: string;
  tableId: string;
  tableName: string;
  status: TableSessionStatus;
  guestCount: number;
  slipNo: number;
  assignedWaiterId: string | null;
  openedBy: string;
  openedAt: string;
  closedAt: string | null;
  version: number;
}

export interface OrderItemDto {
  id: string;
  menuItemId: string;
  nameJa: string;
  nameEn: string | null;
  unitPriceYen: number;
  quantity: number;
  lineTotalYen: number;
  taxRateBp: number;
  note: string | null;
  status: "active" | "voided";
  kitchenItemId: string | null;
  kitchenStatus: KitchenItemStatus | null;
  version: number;
}

export interface OrderDto {
  id: string;
  orderNo: number;
  source: OrderSource;
  createdAt: string;
  items: OrderItemDto[];
}

export interface BillDto {
  tableSessionId: string;
  lines: {
    orderItemId: string;
    orderNo: number;
    nameJa: string;
    nameEn: string | null;
    note: string | null;
    unitPriceYen: number;
    quantity: number;
    lineTotalYen: number;
    taxRateBp: number;
  }[];
  subtotalYen: number;
  taxBreakdown: { rateBp: number; baseYen: number; taxYen: number }[];
  taxTotalYen: number;
  totalYen: number;
  pricesIncludeTax: boolean;
}

export interface SessionDetailResponse {
  session: TableSessionDto;
  orders: OrderDto[];
  bill: BillDto;
}

export interface KitchenItemDto {
  id: string;
  orderItemId: string;
  nameJa: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
  status: KitchenItemStatus;
  version: number;
}

export interface KitchenTicketDto {
  id: string;
  orderId: string;
  orderNo: number;
  /** Null for online (pickup/delivery) tickets, which are shown by order number. */
  tableSessionId: string | null;
  tableName: string | null;
  /** Pickup time / estimated delivery time for online tickets. */
  dueAt: string | null;
  source: OrderSource;
  status: KitchenTicketStatus;
  createdAt: string;
  items: KitchenItemDto[];
}

export interface ReadyItemDto {
  kitchenItemId: string;
  ticketId: string;
  tableSessionId: string;
  tableName: string;
  nameJa: string;
  nameEn: string | null;
  quantity: number;
  note: string | null;
  readyAt: string;
}

export interface CheckoutResultDto {
  paymentId: string;
  receiptId: string;
  receiptNo: number;
  amountDueYen: number;
  amountReceivedYen: number;
  changeYen: number;
}

export interface ReceiptDto {
  id: string;
  receiptNo: number;
  issuedAt: string;
  tableSessionId: string;
  paymentId: string;
  body: {
    brandName: string;
    locationName: string;
    header: string | null;
    footer: string | null;
    timeZone: string;
    tableName: string;
    slipNo: number;
    issuedAt: string;
    lines: {
      nameJa: string;
      nameEn: string | null;
      note: string | null;
      unitPriceYen: number;
      quantity: number;
      lineTotalYen: number;
      taxRateBp: number;
    }[];
    subtotalYen: number;
    taxBreakdown: { rateBp: number; baseYen: number; taxYen: number }[];
    taxTotalYen: number;
    totalYen: number;
    pricesIncludeTax: boolean;
    payment: { method: "cash"; amountReceivedYen: number; changeYen: number };
  };
}

export interface AdminTableDto {
  id: string;
  name: string;
  area: string | null;
  capacity: number;
  isActive: boolean;
  sortOrder: number;
  version: number;
}

export interface PublicTableResponse {
  brand: PublicBrand;
  location: { name: string };
  table: { name: string };
  orderingEnabled: boolean;
  sessionState: "none" | TableSessionStatus;
  joined: boolean;
  menu: {
    id: string;
    name: LocalizedName;
    items: {
      id: string;
      name: LocalizedName;
      description: { ja: string | null; en: string | null };
      priceYen: number;
      isAvailable: boolean;
    }[];
  }[];
}

export interface GuestSessionResponse {
  table: { name: string };
  sessionStatus: TableSessionStatus;
  csrfToken: string;
  orders: {
    id: string;
    orderNo: number;
    source: OrderSource;
    createdAt: string;
    items: {
      id: string;
      nameJa: string;
      nameEn: string | null;
      quantity: number;
      note: string | null;
      unitPriceYen: number;
      kitchenStatus: KitchenItemStatus | null;
    }[];
  }[];
}

/** Socket.IO event names emitted by the server (payloads are minimal; clients refetch). */
export const REALTIME_EVENTS = [
  "table.session.opened",
  "table.session.updated",
  "table.session.closed",
  "order.created",
  "order.updated",
  "kitchen.ticket.created",
  "kitchen.item.status_changed",
  "waiter.food.ready",
  "waiter.food.served",
  "checkout.completed",
  "online.order.created",
  "online.order.accepted",
  "online.order.rejected",
  "online.order.cancelled",
  "online.order.preparing",
  "online.order.ready",
  "online.order.dispatched",
  "online.order.delivered",
  "online.order.completed",
  "online.order.payment_recorded",
] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

// ---------------------------------------------------------------- online ordering (pickup / delivery)

export type FulfillmentType = "pickup" | "delivery";
export type OnlineOrderStatus =
  | "pending_acceptance"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "completed"
  | "rejected"
  | "cancelled";
export type OnlinePaymentMethod = "pay_on_pickup" | "cash_on_delivery";
export type OnlinePaymentStatus = "unpaid" | "paid" | "refund_required" | "voided";
export type StoreState = "open" | "paused" | "closed" | "unavailable";

export type RejectionReason =
  "store_busy" | "item_unavailable" | "outside_hours" | "cannot_deliver" | "other";
export type CancellationReason =
  "customer_request" | "no_show" | "cannot_fulfill" | "delivery_failed" | "other";

export interface HoursWindowDto {
  weekday: number; // 0 = Sunday
  opensAt: string; // "HH:MM"
  closesAt: string; // "HH:MM" ("24:00" = end of day)
}

export interface FeeTierDto {
  maxDistanceM: number;
  feeYen: number;
  minOrderYen: number;
}

export interface TaxBreakdownDto {
  rateBp: number;
  baseYen: number;
  taxYen: number;
}

export interface StorefrontResponse {
  brand: PublicBrand;
  location: { name: string; timeZone: string };
  state: StoreState;
  hours: HoursWindowDto[];
  minOrderYen?: number;
  checkoutNote?: { ja: string | null; en: string | null };
  pricesIncludeTax?: boolean;
  pickup: { prepMinutes: number; slots: string[]; paymentMethod: OnlinePaymentMethod } | null;
  delivery: {
    prepMinutes: number;
    radiusM: number;
    tiers: FeeTierDto[];
    distanceBasis: "straight_line";
    paymentMethod: OnlinePaymentMethod;
  } | null;
  menu: PublicTableResponse["menu"];
}

export interface DeliveryAddressInput {
  postalCode: string;
  prefecture: string;
  city: string;
  line1: string;
  line2?: string | null;
  instructions?: string | null;
}

export interface OnlineQuoteDto {
  itemsSubtotalYen: number;
  deliveryFeeYen: number;
  taxBreakdown: TaxBreakdownDto[];
  taxTotalYen: number;
  totalYen: number;
  pricesIncludeTax: boolean;
  minimumYen: number;
  meetsMinimum: boolean;
  deliveryDistanceM: number | null;
}

export interface OnlineOrderPlacedDto {
  onlineOrderId: string;
  orderNo: number;
  status: OnlineOrderStatus;
  fulfillmentType: FulfillmentType;
  scheduledFor: string;
  totalYen: number;
  trackingToken: string;
}

export interface OnlineTrackingDto {
  store: { name: string; timeZone: string };
  brand: PublicBrand;
  onlineOrderId: string;
  orderNo: number;
  fulfillmentType: FulfillmentType;
  status: OnlineOrderStatus;
  paymentMethod: OnlinePaymentMethod;
  paymentStatus: OnlinePaymentStatus;
  scheduledFor: string;
  createdAt: string;
  rejectionReason: string | null;
  cancellationReason: string | null;
  cancelledBy: "staff" | "customer" | null;
  canCancel: boolean;
  items: {
    id: string;
    nameJa: string;
    nameEn: string | null;
    quantity: number;
    note: string | null;
    unitPriceYen: number;
    lineTotalYen: number;
  }[];
  totals: {
    itemsSubtotalYen: number;
    deliveryFeeYen: number;
    taxBreakdown: TaxBreakdownDto[];
    taxTotalYen: number;
    totalYen: number;
    pricesIncludeTax: boolean;
  };
}

export interface OnlineOrderSummaryDto {
  id: string;
  orderNo: number;
  fulfillmentType: FulfillmentType;
  status: OnlineOrderStatus;
  paymentMethod: OnlinePaymentMethod;
  paymentStatus: OnlinePaymentStatus;
  scheduledFor: string;
  createdAt: string;
  totalYen: number;
  deliveryDistanceM: number | null;
  version: number;
  items: { nameJa: string; nameEn: string | null; quantity: number; note: string | null }[];
}

export interface OnlineOrderListResponse {
  orders: OnlineOrderSummaryDto[];
  ordering: { enabled: boolean; paused: boolean };
}

export interface OnlineOrderDetailDto {
  id: string;
  orderId: string;
  orderNo: number;
  fulfillmentType: FulfillmentType;
  status: OnlineOrderStatus;
  paymentMethod: OnlinePaymentMethod;
  paymentStatus: OnlinePaymentStatus;
  scheduledFor: string;
  createdAt: string;
  itemsSubtotalYen: number;
  deliveryFeeYen: number;
  taxTotalYen: number;
  totalYen: number;
  taxBreakdown: TaxBreakdownDto[];
  pricesIncludeTax: boolean;
  deliveryDistanceM: number | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  cancelledBy: "staff" | "customer" | null;
  version: number;
  items: {
    id: string;
    nameJa: string;
    nameEn: string | null;
    quantity: number;
    note: string | null;
    unitPriceYen: number;
    lineTotalYen: number;
    taxRateBp: number;
    status: "active" | "voided";
    kitchenStatus: KitchenItemStatus | null;
  }[];
  history: {
    from: OnlineOrderStatus | null;
    to: OnlineOrderStatus;
    actorType: "staff" | "customer" | "system";
    reason: string | null;
    at: string;
  }[];
  payment: {
    paymentId: string;
    method: "cash";
    amountDueYen: number;
    amountReceivedYen: number;
    changeYen: number;
    recordedAt: string;
  } | null;
  canViewContact: boolean;
}

export interface OnlineOrderContactDto {
  name: string;
  phone: string;
  email: string | null;
  address: {
    postalCode: string | null;
    prefecture: string | null;
    city: string | null;
    line1: string | null;
    line2: string | null;
    instructions: string | null;
  } | null;
}

export interface OnlineSettingsDto {
  enabled: boolean;
  paused: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  payAtHandoverEnabled: boolean;
  pickupPrepMinutes: number;
  pickupSlotMinutes: number;
  pickupDaysAhead: number;
  deliveryPrepMinutes: number;
  minOrderYen: number;
  storeLocation: { latitude: number; longitude: number } | null;
  checkoutNote: { ja: string | null; en: string | null };
}

export interface OnlineSettingsResponse {
  version: number;
  settings: OnlineSettingsDto;
  hours: HoursWindowDto[];
  tiers: FeeTierDto[];
  link: { token: string; issuedAt: string };
  features: { pickup: boolean; delivery: boolean };
  geocoderEnabled: boolean;
}
