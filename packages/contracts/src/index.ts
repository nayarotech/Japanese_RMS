/**
 * @restaurant-platform/contracts: wire types shared by the web app and the API (JSON shapes; dates are ISO strings).
 * Identifiers only for features/permissions; the API decides what is allowed.
 */

export type Locale = "ja" | "en";
export type StaffRole = "owner" | "manager" | "cashier" | "waiter" | "kitchen";
export type OrderSource = "STAFF_POS" | "TABLE_QR";
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
  tableSessionId: string;
  tableName: string;
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
] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];
