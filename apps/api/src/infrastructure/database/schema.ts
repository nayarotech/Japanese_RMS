/**
 * Kysely table types. Hand-maintained to mirror migrations/*.ts.
 * Each module may only query the tables it owns (see modules/README.md).
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Json<T> = ColumnType<T, T, T>;

export type StaffRole = "owner" | "manager" | "cashier" | "waiter" | "kitchen";
export type OrderSource = "STAFF_POS" | "TABLE_QR" | "ONLINE_PICKUP" | "ONLINE_DELIVERY";
// Status/value types are owned by the domain layer (dependencies point inward).
import type {
  KitchenItemStatus,
  KitchenTicketStatus,
} from "../../modules/kitchen/domain/status.js";
import type { TaxRounding } from "../../modules/orders/domain/pricing.js";
import type { TableSessionStatus } from "../../modules/tables/domain/session-rules.js";
import type {
  FulfillmentType,
  OnlineOrderStatus,
  OnlinePaymentMethod,
  OnlinePaymentStatus,
} from "../../modules/online-orders/domain/status.js";
export type { KitchenItemStatus, KitchenTicketStatus, TableSessionStatus, TaxRounding };
export type { FulfillmentType, OnlineOrderStatus, OnlinePaymentMethod, OnlinePaymentStatus };

export interface BrandsTable {
  id: Generated<string>;
  display_name: string;
  short_mark: string;
  primary_color: string;
  support_email: string | null;
  support_phone: string | null;
  created_at: Generated<Date>;
}
export interface BrandDomainsTable {
  host: string;
  brand_id: string;
}
export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  status: Generated<"active" | "disabled">;
  failed_login_count: Generated<number>;
  locked_until: NullableTimestamp;
  created_at: Generated<Date>;
}
export interface PlansTable {
  id: Generated<string>;
  code: string;
  name: string;
}
export interface PlanVersionsTable {
  id: Generated<string>;
  plan_id: string;
  version: number;
  published_at: Generated<Date>;
}
export interface PlanVersionFeaturesTable {
  plan_version_id: string;
  feature_key: string;
}
export interface TenantsTable {
  id: Generated<string>;
  brand_id: string;
  name: string;
  status: Generated<"active" | "suspended" | "closed">;
  created_at: Generated<Date>;
}
export interface LocationsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  time_zone: Generated<string>;
  business_day_cutoff: Generated<string>;
  prices_include_tax: Generated<boolean>;
  tax_rounding: Generated<TaxRounding>;
  qr_ordering_enabled: Generated<boolean>;
  receipt_header: string | null;
  receipt_footer: string | null;
  created_at: Generated<Date>;
}
export interface TaxRatesTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  code: string;
  rate_bp: number;
  created_at: Generated<Date>;
}
export interface LocationMembershipsTable {
  tenant_id: string;
  location_id: string;
  user_id: string;
  role: StaffRole;
  created_at: Generated<Date>;
}
export interface StaffSessionsTable {
  id: Generated<string>;
  token_hash: Buffer;
  user_id: string;
  tenant_id: string;
  location_id: string;
  created_at: Generated<Date>;
  last_seen_at: Timestamp;
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  ip: string | null;
  user_agent: string | null;
}
export interface SubscriptionsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  plan_version_id: string;
  status: "trial" | "active" | "past_due" | "suspended" | "cancelled" | "expired";
  starts_at: Timestamp;
  ends_at: NullableTimestamp;
  created_at: Generated<Date>;
}
export interface LocationCountersTable {
  tenant_id: string;
  location_id: string;
  counter: "slip" | "order" | "receipt";
  value: ColumnType<string, string | number | undefined, string | number>;
}
export interface IdempotencyRecordsTable {
  tenant_id: string;
  scope: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: Json<unknown> | null;
  created_at: Generated<Date>;
}
export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string | null;
  actor_type: "staff" | "guest" | "system";
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Json<Record<string, unknown>>;
  request_id: string | null;
  ip: string | null;
  created_at: Generated<Date>;
}
export interface OutboxEventsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string | null;
  event_type: string;
  payload: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
  processed_at: NullableTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
}
export interface RestaurantTablesTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  name: string;
  area: string | null;
  capacity: number;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface TableQrTokensTable {
  token: string;
  tenant_id: string;
  location_id: string;
  table_id: string;
  issued_at: Generated<Date>;
  revoked_at: NullableTimestamp;
}
export interface TableSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  table_id: string;
  status: Generated<TableSessionStatus>;
  guest_count: number;
  slip_no: number;
  assigned_waiter_id: string | null;
  opened_by: string | null;
  opened_at: Generated<Date>;
  bill_requested_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  closed_by: string | null;
  version: Generated<number>;
}
export interface GuestSessionsTable {
  id: Generated<string>;
  token_hash: Buffer;
  tenant_id: string;
  location_id: string;
  table_session_id: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  ip: string | null;
}
export interface MenuCategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}
export interface MenuCategoryTranslationsTable {
  tenant_id: string;
  category_id: string;
  locale: "ja" | "en";
  name: string;
}
export interface MenuItemsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  category_id: string;
  code: string | null;
  price_yen: number;
  tax_rate_id: string;
  takeout_tax_rate_id: Generated<string | null>;
  is_available: Generated<boolean>;
  is_active: Generated<boolean>;
  sort_order: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface MenuItemTranslationsTable {
  tenant_id: string;
  menu_item_id: string;
  locale: "ja" | "en";
  name: string;
  description: string | null;
}
export type MenuItemImageStatus = "pending" | "active" | "retired" | "deleted";
export interface MenuItemImagesTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  menu_item_id: string;
  status: Generated<MenuItemImageStatus>;
  storage_key: string;
  thumb_storage_key: string;
  content_type: "image/webp";
  width: number;
  height: number;
  byte_size: number;
  thumb_width: number;
  thumb_height: number;
  thumb_byte_size: number;
  source_content_type: "image/jpeg" | "image/png" | "image/webp";
  source_byte_size: number;
  uploaded_by: string | null;
  created_at: Generated<Date>;
  activated_at: NullableTimestamp;
  retired_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
  cleanup_attempts: Generated<number>;
}
export interface OrdersTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  table_session_id: string | null;
  order_no: number;
  source: OrderSource;
  created_by_user_id: string | null;
  guest_session_id: string | null;
  created_at: Generated<Date>;
}
export interface OrderItemsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  order_id: string;
  table_session_id: string | null;
  menu_item_id: string;
  name_ja: string;
  name_en: string | null;
  unit_price_yen: number;
  quantity: number;
  line_total_yen: ColumnType<number, never, never>;
  tax_rate_bp: number;
  note: string | null;
  status: Generated<"active" | "voided">;
  voided_at: NullableTimestamp;
  voided_by: string | null;
  void_reason: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
}
export interface KitchenTicketsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  order_id: string;
  table_session_id: string | null;
  table_name: string | null;
  order_no: number;
  due_at: NullableTimestamp;
  source: OrderSource;
  status: Generated<KitchenTicketStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface KitchenTicketItemsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  ticket_id: string;
  order_item_id: string;
  name_ja: string;
  name_en: string | null;
  quantity: number;
  note: string | null;
  status: Generated<KitchenItemStatus>;
  started_at: NullableTimestamp;
  ready_at: NullableTimestamp;
  served_at: NullableTimestamp;
  served_by: string | null;
  version: Generated<number>;
}
export interface PaymentsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  table_session_id: string | null;
  order_id: Generated<string | null>;
  method: "cash";
  status: Generated<"completed">;
  amount_due_yen: number;
  amount_received_yen: number;
  change_yen: number;
  received_by: string;
  created_at: Generated<Date>;
}
export interface ReceiptsTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  payment_id: string;
  table_session_id: string;
  receipt_no: number;
  issued_at: Generated<Date>;
  body: Json<Record<string, unknown>>;
}
export interface EntitlementOverridesTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  feature_key: string;
  effect: "grant" | "revoke";
  reason: string;
  granted_by: string;
  starts_at: Timestamp;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: Generated<Date>;
}
export interface OnlineOrderingSettingsTable {
  location_id: string;
  tenant_id: string;
  is_enabled: Generated<boolean>;
  is_paused: Generated<boolean>;
  pickup_enabled: Generated<boolean>;
  delivery_enabled: Generated<boolean>;
  pay_at_handover_enabled: Generated<boolean>;
  pickup_prep_minutes: Generated<number>;
  pickup_slot_minutes: Generated<number>;
  pickup_days_ahead: Generated<number>;
  delivery_prep_minutes: Generated<number>;
  min_order_yen: Generated<number>;
  store_latitude: number | null;
  store_longitude: number | null;
  checkout_note_ja: string | null;
  checkout_note_en: string | null;
  version: Generated<number>;
  updated_at: Generated<Date>;
  updated_by: string | null;
}
export interface OnlineOrderingHoursTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  weekday: number;
  opens_at: string;
  closes_at: string;
}
export interface DeliveryFeeTiersTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  max_distance_m: number;
  fee_yen: number;
  min_order_yen: Generated<number>;
}
export interface OnlineStoreLinksTable {
  token: string;
  tenant_id: string;
  location_id: string;
  issued_at: Generated<Date>;
  revoked_at: NullableTimestamp;
}
export interface OnlineOrdersTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  order_id: string;
  order_no: number;
  fulfillment_type: FulfillmentType;
  status: Generated<OnlineOrderStatus>;
  payment_method: OnlinePaymentMethod;
  payment_status: Generated<OnlinePaymentStatus>;
  scheduled_for: Timestamp;
  items_subtotal_yen: number;
  delivery_fee_yen: Generated<number>;
  tax_total_yen: number;
  total_yen: number;
  tax_breakdown: Json<{ rateBp: number; baseYen: number; taxYen: number }[]>;
  prices_include_tax: boolean;
  delivery_distance_m: number | null;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  cancelled_by: "staff" | "customer" | null;
  accepted_at: NullableTimestamp;
  ready_at: NullableTimestamp;
  dispatched_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface OnlineOrderContactsTable {
  online_order_id: string;
  tenant_id: string;
  location_id: string;
  name: string;
  phone: string;
  email: string | null;
  postal_code: string | null;
  prefecture: string | null;
  city: string | null;
  address_line1: string | null;
  address_line2: string | null;
  delivery_instructions: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_precision: string | null;
  created_at: Generated<Date>;
}
export interface OnlineOrderStatusHistoryTable {
  id: Generated<string>;
  tenant_id: string;
  location_id: string;
  online_order_id: string;
  from_status: OnlineOrderStatus | null;
  to_status: OnlineOrderStatus;
  actor_type: "staff" | "customer" | "system";
  actor_id: string | null;
  reason: string | null;
  created_at: Generated<Date>;
}
export interface OnlineOrderTrackingTokensTable {
  id: Generated<string>;
  token_hash: Buffer;
  tenant_id: string;
  location_id: string;
  online_order_id: string;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface Database {
  brands: BrandsTable;
  brand_domains: BrandDomainsTable;
  users: UsersTable;
  plans: PlansTable;
  plan_versions: PlanVersionsTable;
  plan_version_features: PlanVersionFeaturesTable;
  tenants: TenantsTable;
  locations: LocationsTable;
  tax_rates: TaxRatesTable;
  location_memberships: LocationMembershipsTable;
  staff_sessions: StaffSessionsTable;
  subscriptions: SubscriptionsTable;
  location_counters: LocationCountersTable;
  idempotency_records: IdempotencyRecordsTable;
  audit_events: AuditEventsTable;
  outbox_events: OutboxEventsTable;
  restaurant_tables: RestaurantTablesTable;
  table_qr_tokens: TableQrTokensTable;
  table_sessions: TableSessionsTable;
  guest_sessions: GuestSessionsTable;
  menu_categories: MenuCategoriesTable;
  menu_category_translations: MenuCategoryTranslationsTable;
  menu_items: MenuItemsTable;
  menu_item_translations: MenuItemTranslationsTable;
  menu_item_images: MenuItemImagesTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  kitchen_tickets: KitchenTicketsTable;
  kitchen_ticket_items: KitchenTicketItemsTable;
  payments: PaymentsTable;
  receipts: ReceiptsTable;
  entitlement_overrides: EntitlementOverridesTable;
  online_ordering_settings: OnlineOrderingSettingsTable;
  online_ordering_hours: OnlineOrderingHoursTable;
  delivery_fee_tiers: DeliveryFeeTiersTable;
  online_store_links: OnlineStoreLinksTable;
  online_orders: OnlineOrdersTable;
  online_order_contacts: OnlineOrderContactsTable;
  online_order_status_history: OnlineOrderStatusHistoryTable;
  online_order_tracking_tokens: OnlineOrderTrackingTokensTable;
}

export type NewRow<T extends keyof Database> = Insertable<Database[T]>;
export type Row<T extends keyof Database> = Selectable<Database[T]>;
export type RowUpdate<T extends keyof Database> = Updateable<Database[T]>;
