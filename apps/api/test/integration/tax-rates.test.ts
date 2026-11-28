/**
 * Manually entered tax rates (POST /menu/tax-rates): find-or-create by value, usable on menu items,
 * permission-checked and tenant-isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantFixture } from "../../src/infrastructure/database/fixtures.js";
import { type StaffClient, loginStaff } from "../helpers/clients.js";
import { type Harness, TEST_PASSWORD, createHarness } from "../helpers/harness.js";

let h: Harness;
let A: TenantFixture;
let B: TenantFixture;
let managerA: StaffClient;
let cashierA: StaffClient;
let managerB: StaffClient;

type Rate = { id: string; code: string; rateBp: number };
const ratesOf = async (c: StaffClient) => (await c.get("/menu")).body.taxRates as Rate[];

beforeAll(async () => {
  h = await createHarness();
  [A, B] = await Promise.all([h.fixture(), h.fixture()]);
  [managerA, cashierA, managerB] = await Promise.all([
    loginStaff(h.app, A.users.manager.email, TEST_PASSWORD),
    loginStaff(h.app, A.users.cashier.email, TEST_PASSWORD),
    loginStaff(h.app, B.users.manager.email, TEST_PASSWORD),
  ]);
});
afterAll(async () => h.close());

describe("manual tax rates", () => {
  it("reuses an existing rate with the same value", async () => {
    const res = await managerA.post("/menu/tax-rates", { rateBp: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: A.taxRates.standard, code: "standard", rateBp: 1000 });
  });

  it("creates a new rate once, then returns it again, and it can be used on an item", async () => {
    const first = await managerA.post("/menu/tax-rates", { rateBp: 1050 });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ code: "custom_1050", rateBp: 1050 });
    const again = await managerA.post("/menu/tax-rates", { rateBp: 1050 });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const rates = await ratesOf(managerA);
    expect(rates.map((r) => r.rateBp)).toEqual([800, 1000, 1050]);

    const menu = await managerA.get("/menu");
    const categoryId = (menu.body.categories as { id: string }[])[0]!.id;
    const created = await managerA.post("/menu/items", {
      categoryId,
      taxRateId: first.body.id,
      takeoutTaxRateId: first.body.id,
      priceYen: 1000,
      nameJa: "税率テスト",
    });
    expect(created.status).toBe(201);
    const item = (await managerA.get("/menu")).body.categories
      .flatMap(
        (c: { items: { id: string; taxRateBp: number; takeoutTaxRateBp: number }[] }) => c.items,
      )
      .find((i: { id: string }) => i.id === created.body.id);
    expect(item).toMatchObject({ taxRateBp: 1050, takeoutTaxRateBp: 1050 });
  });

  it("is per location: another restaurant does not see or reuse it", async () => {
    expect((await ratesOf(managerB)).map((r) => r.rateBp)).toEqual([800, 1000]);
    const res = await managerB.post("/menu/tax-rates", { rateBp: 1050 });
    expect(res.status).toBe(201);
    expect((await ratesOf(managerA)).filter((r) => r.rateBp === 1050)).toHaveLength(1);
  });

  it("rejects invalid values and staff without menu.manage", async () => {
    for (const rateBp of [-1, 10_001, 10.5, "10"]) {
      expect((await managerA.post("/menu/tax-rates", { rateBp })).status).toBe(400);
    }
    expect((await cashierA.post("/menu/tax-rates", { rateBp: 900 })).status).toBe(403);
  });
});
