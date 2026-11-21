"use client";
/** Menu management: availability (sold-out) toggles and adding items. Prices are integer yen. */
import type { StaffMenuResponse } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { LangToggle } from "../../../../../components/LangToggle";
import { PageHeader } from "../../../../../components/PageHeader";
import { Banner, Button, Dialog, Spinner } from "../../../../../components/ui";
import { errorKey, staffApi } from "../../../../../lib/api";
import { formatYen, pickName, ratePercent } from "../../../../../lib/format";
import { type FormSubmitEvent, field } from "../../../../../lib/forms";

export default function AdminMenuPage() {
  const t = useTranslations();
  const locale = useLocale();
  const [menu, setMenu] = useState<StaffMenuResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    staffApi
      .get<StaffMenuResponse>("/menu")
      .then(setMenu)
      .catch((err: unknown) => setError(t(errorKey(err))));
  }, [t]);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(t(errorKey(err)));
    }
    load();
  }

  async function create(e: FormSubmitEvent) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setAdding(false);
    await run(() =>
      staffApi.send("POST", "/menu/items", {
        categoryId: field(f, "categoryId"),
        taxRateId: field(f, "taxRateId"),
        takeoutTaxRateId: field(f, "takeoutTaxRateId") || null,
        priceYen: Number(field(f, "priceYen")),
        nameJa: field(f, "nameJa"),
        nameEn: field(f, "nameEn") || null,
      }),
    );
  }

  return (
    <>
      <PageHeader title={t("adminMenu.title")}>
        <Button variant="dark" className="h-11 px-4" onClick={() => setAdding(true)}>
          + {t("adminMenu.addItem")}
        </Button>
        <LangToggle />
      </PageHeader>
      <section className="min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
        {error && (
          <div className="mb-4">
            <Banner>{error}</Banner>
          </div>
        )}
        {!menu ? (
          <Spinner label={t("common.loading")} />
        ) : (
          <div className="space-y-6">
            {menu.categories.map((c) => (
              <div key={c.id}>
                <h2 className="mb-2 text-[16px] font-bold">{pickName(c.name, locale)}</h2>
                <ul className="divide-y divide-line-soft rounded-[12px] border border-line bg-white">
                  {c.items.map((i) => (
                    <li key={i.id} className="flex items-center gap-4 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-medium">
                          {i.name.ja}
                          {i.name.en ? (
                            <span className="ml-2 text-[13px] text-muted">{i.name.en}</span>
                          ) : null}
                        </p>
                        <p className="text-[12px] text-muted">
                          {t("adminMenu.taxSummary", {
                            dineIn: ratePercent(i.taxRateBp),
                            takeout: ratePercent(i.takeoutTaxRateBp),
                          })}
                        </p>
                      </div>
                      <span className="w-24 text-right text-[15px] font-semibold">
                        {formatYen(i.priceYen, locale)}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={i.isAvailable}
                        onClick={() =>
                          void run(() =>
                            staffApi.send("PATCH", `/menu/items/${i.id}/availability`, {
                              isAvailable: !i.isAvailable,
                            }),
                          )
                        }
                        className={`h-9 w-28 rounded-full text-[13px] font-semibold ${i.isAvailable ? "bg-brand-tint text-brand" : "bg-chip text-muted"}`}
                      >
                        {i.isAvailable ? t("adminMenu.available") : t("adminMenu.soldOut")}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
      {adding && menu && (
        <Dialog title={t("adminMenu.addItem")} onClose={() => setAdding(false)}>
          <form onSubmit={(e) => void create(e)} className="space-y-3">
            <label className="block text-[14px] font-medium">
              {t("adminMenu.nameJa")}
              <input
                name="nameJa"
                required
                maxLength={80}
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              />
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminMenu.nameEn")}
              <input
                name="nameEn"
                maxLength={80}
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              />
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminMenu.price")}
              <input
                name="priceYen"
                type="number"
                min={0}
                max={10000000}
                step={1}
                required
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              />
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminMenu.category")}
              <select
                name="categoryId"
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              >
                {menu.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {pickName(c.name, locale)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminMenu.tax")}
              <select
                name="taxRateId"
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              >
                {menu.taxRates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {ratePercent(r.rateBp)}% ({r.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminMenu.takeoutTax")}
              <select
                name="takeoutTaxRateId"
                defaultValue=""
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              >
                <option value="">{t("adminMenu.sameAsDineIn")}</option>
                {menu.taxRates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {ratePercent(r.rateBp)}% ({r.code})
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" variant="dark" className="h-12 w-full">
              {t("adminMenu.create")}
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}
