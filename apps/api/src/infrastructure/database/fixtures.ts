/**
 * Development and test fixtures. Runs with the MIGRATOR connection (platform rows such as brands and
 * plans are not writable by the runtime role). NEVER imported by the running API or worker.
 *
 * Plans: Basic and Standard both include the same dine-in feature keys. That is the point: one
 * implementation, reused by every package that includes the feature.
 */
import { type Kysely, sql } from "kysely";
import { hashPassword } from "../../modules/identity/application/passwords.js";
import { newQrToken } from "../security/tokens.js";
import type { Database, StaffRole } from "./schema.js";

export const DINE_IN_FEATURES = [
  "table_management",
  "dine_in_pos",
  "table_qr_ordering",
  "kitchen_workflow",
  "cash_checkout",
] as const;

export interface TenantFixture {
  brandId: string;
  tenantId: string;
  locationId: string;
  taxRates: { standard: string; reduced: string };
  users: Record<StaffRole, { id: string; email: string; password: string }>;
  tables: { id: string; name: string; qrToken: string }[];
  menu: { id: string; nameEn: string; priceYen: number }[];
}

export interface FixtureOptions {
  /** Unique slug used in emails/names so several fixtures can coexist (tests create two tenants). */
  slug: string;
  password: string;
  planCode?: string;
  subscriptionStatus?: "trial" | "active" | "past_due" | "suspended" | "cancelled" | "expired";
  brandHost?: string;
  tables?: { name: string; capacity: number; area: string }[];
}

const DEFAULT_TABLES = [
  ...["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7", "A-8"].map((name, i) => ({
    name,
    capacity: [4, 2, 2, 4, 4, 6, 2, 2][i] ?? 2,
    area: "1F Hall",
  })),
  ...["C-1", "C-2", "C-3", "C-4"].map((name) => ({ name, capacity: 1, area: "Counter" })),
];

// Demo menu content (restaurant data, not UI translations).
const DEMO_MENU: { category: [string, string]; items: [string, string, number, string?][] }[] = [
  {
    category: ["フード", "Food"],
    items: [
      ["から揚げ定食", "Karaage set meal", 980, "Crispy fried chicken with rice and miso soup"],
      ["醤油ラーメン", "Shoyu ramen", 850, "Soy sauce broth, chashu, egg"],
      ["焼き鮭定食", "Grilled salmon set", 1080],
      ["天ぷらそば", "Tempura soba", 920],
      ["枝豆", "Edamame", 380],
      ["だし巻き卵", "Dashimaki tamago", 480],
    ],
  },
  {
    category: ["ドリンク", "Drinks"],
    items: [
      ["生ビール（中）", "Draft beer (M)", 550],
      ["ハイボール", "Highball", 480],
      ["烏龍茶", "Oolong tea", 300],
      ["緑茶", "Green tea", 250],
    ],
  },
  {
    category: ["デザート", "Desserts"],
    items: [
      ["抹茶アイス", "Matcha ice cream", 420],
      ["わらび餅", "Warabi mochi", 450],
    ],
  },
  { category: ["セット", "Sets"], items: [["日替わりランチ", "Daily lunch set", 1200]] },
];

export async function ensurePlans(db: Kysely<Database>): Promise<void> {
  for (const [code, name] of [
    ["basic", "Basic"],
    ["standard", "Standard"],
  ] as const) {
    const plan = await db
      .insertInto("plans")
      .values({ code, name })
      .onConflict((oc) => oc.column("code").doUpdateSet({ name }))
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await db
      .insertInto("plan_versions")
      .values({ plan_id: plan.id, version: 1 })
      .onConflict((oc) => oc.columns(["plan_id", "version"]).doUpdateSet({ version: 1 }))
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("plan_version_features")
      .values(DINE_IN_FEATURES.map((feature_key) => ({ plan_version_id: version.id, feature_key })))
      .onConflict((oc) => oc.columns(["plan_version_id", "feature_key"]).doNothing())
      .execute();
  }
}

export async function createTenantFixture(
  db: Kysely<Database>,
  opts: FixtureOptions,
): Promise<TenantFixture> {
  await ensurePlans(db);
  const passwordHash = await hashPassword(opts.password);

  const brand = await db
    .insertInto("brands")
    .values({ display_name: "Brand Placeholder", short_mark: "R", primary_color: "#db020e" })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (opts.brandHost) {
    await db
      .insertInto("brand_domains")
      .values({ host: opts.brandHost, brand_id: brand.id })
      .onConflict((oc) => oc.column("host").doUpdateSet({ brand_id: brand.id }))
      .execute();
  }

  const roles: StaffRole[] = ["owner", "manager", "cashier", "waiter", "kitchen"];
  const users = {} as TenantFixture["users"];
  for (const role of roles) {
    const email = `${role}@${opts.slug}.example.test`;
    const displayName = `${role[0]?.toUpperCase() ?? ""}${role.slice(1)} (${opts.slug})`;
    const u = await db
      .insertInto("users")
      .values({ email, password_hash: passwordHash, display_name: displayName })
      .returning("id")
      .executeTakeFirstOrThrow();
    users[role] = { id: u.id, email, password: opts.password };
  }

  const tenantId = (await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(db)).rows[0]?.id;
  if (!tenantId) throw new Error("uuidv7() failed");

  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
    await tx
      .insertInto("tenants")
      .values({ id: tenantId, brand_id: brand.id, name: `Tenant ${opts.slug}` })
      .execute();
    const location = await tx
      .insertInto("locations")
      .values({ tenant_id: tenantId, name: `Sample Store (${opts.slug})` })
      .returning("id")
      .executeTakeFirstOrThrow();
    const standard = await tx
      .insertInto("tax_rates")
      .values({ tenant_id: tenantId, location_id: location.id, code: "standard", rate_bp: 1000 })
      .returning("id")
      .executeTakeFirstOrThrow();
    const reduced = await tx
      .insertInto("tax_rates")
      .values({ tenant_id: tenantId, location_id: location.id, code: "reduced", rate_bp: 800 })
      .returning("id")
      .executeTakeFirstOrThrow();

    for (const role of roles) {
      await tx
        .insertInto("location_memberships")
        .values({ tenant_id: tenantId, location_id: location.id, user_id: users[role].id, role })
        .execute();
    }

    const planVersion = await tx
      .selectFrom("plan_versions as pv")
      .innerJoin("plans as p", "p.id", "pv.plan_id")
      .select("pv.id")
      .where("p.code", "=", opts.planCode ?? "basic")
      .where("pv.version", "=", 1)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("subscriptions")
      .values({
        tenant_id: tenantId,
        location_id: location.id,
        plan_version_id: planVersion.id,
        status: opts.subscriptionStatus ?? "active",
        starts_at: new Date(Date.now() - 86_400_000),
      })
      .execute();

    const tables: TenantFixture["tables"] = [];
    for (const [i, t] of (opts.tables ?? DEFAULT_TABLES).entries()) {
      const row = await tx
        .insertInto("restaurant_tables")
        .values({
          tenant_id: tenantId,
          location_id: location.id,
          name: t.name,
          capacity: t.capacity,
          area: t.area,
          sort_order: i,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const qrToken = newQrToken();
      await tx
        .insertInto("table_qr_tokens")
        .values({ token: qrToken, tenant_id: tenantId, location_id: location.id, table_id: row.id })
        .execute();
      tables.push({ id: row.id, name: t.name, qrToken });
    }

    const menu: TenantFixture["menu"] = [];
    for (const [ci, cat] of DEMO_MENU.entries()) {
      const c = await tx
        .insertInto("menu_categories")
        .values({ tenant_id: tenantId, location_id: location.id, sort_order: ci })
        .returning("id")
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("menu_category_translations")
        .values([
          { tenant_id: tenantId, category_id: c.id, locale: "ja", name: cat.category[0] },
          { tenant_id: tenantId, category_id: c.id, locale: "en", name: cat.category[1] },
        ])
        .execute();
      for (const [ii, [ja, en, price, desc]] of cat.items.entries()) {
        const item = await tx
          .insertInto("menu_items")
          .values({
            tenant_id: tenantId,
            location_id: location.id,
            category_id: c.id,
            price_yen: price,
            tax_rate_id: standard.id,
            sort_order: ii,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("menu_item_translations")
          .values([
            {
              tenant_id: tenantId,
              menu_item_id: item.id,
              locale: "ja",
              name: ja,
              description: null,
            },
            {
              tenant_id: tenantId,
              menu_item_id: item.id,
              locale: "en",
              name: en,
              description: desc ?? null,
            },
          ])
          .execute();
        menu.push({ id: item.id, nameEn: en, priceYen: price });
      }
    }

    return {
      brandId: brand.id,
      tenantId,
      locationId: location.id,
      taxRates: { standard: standard.id, reduced: reduced.id },
      users,
      tables,
      menu,
    };
  });
}
