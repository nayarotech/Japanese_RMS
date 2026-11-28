"use client";
/** Menu management: availability (sold-out) toggles, adding and editing items, item photos. Prices are integer yen. */
import type { MenuItemDto, StaffMenuResponse } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { LangToggle } from "../../../../../components/LangToggle";
import { MenuItemImage } from "../../../../../components/MenuItemImage";
import { PageHeader } from "../../../../../components/PageHeader";
import { Banner, Button, Dialog, Spinner } from "../../../../../components/ui";
import {
  MenuPhotoField,
  type PhotoChange,
  photoErrorKey,
} from "../../../../../features/menu/MenuPhotoField";
import { errorKey, staffApi } from "../../../../../lib/api";
import { formatYen, pickName, ratePercent } from "../../../../../lib/format";
import { type FormSubmitEvent, field } from "../../../../../lib/forms";

/**
 * Editor state: a new item, or an existing one (by id, so it always reflects the latest loaded menu).
 * `session` keeps the dialog mounted when a just-created item switches to edit mode (e.g. to retry its photo).
 */
type Editor = { session: number } & ({ mode: "add" } | { mode: "edit"; itemId: string });
let editorSessions = 0;

interface ItemFields {
  categoryId: string;
  taxRateId: string;
  takeoutTaxRateId: string | null;
  priceYen: number;
  nameJa: string;
  nameEn: string | null;
}

/** Select value meaning "enter the percentage by hand" (tax law changes faster than releases). */
const CUSTOM_TAX = "__custom";

/** Percent text ("8", "10", "8.5") to basis points; null when not a valid 0–100% with at most 2 decimals. */
function percentToBp(text: string): number | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text.trim())) return null;
  const bp = Math.round(Number(text) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
}

/** Replaces a "custom" tax choice with the id of the matching rate, creating that rate if needed. */
async function resolveTaxRate(f: FormData, name: string): Promise<void> {
  if (f.get(name) !== CUSTOM_TAX) return;
  const bp = percentToBp(field(f, `${name}Custom`));
  if (bp === null) throw new Error("invalid tax percent");
  const rate = await staffApi.send<{ id: string }>("POST", "/menu/tax-rates", { rateBp: bp });
  f.set(name, rate.id);
}

function readFields(f: FormData): ItemFields {
  return {
    categoryId: field(f, "categoryId"),
    taxRateId: field(f, "taxRateId"),
    takeoutTaxRateId: field(f, "takeoutTaxRateId") || null,
    priceYen: Number(field(f, "priceYen")),
    nameJa: field(f, "nameJa"),
    nameEn: field(f, "nameEn") || null,
  };
}

function fieldsChanged(a: ItemFields, item: MenuItemDto): boolean {
  return (
    a.categoryId !== item.categoryId ||
    a.taxRateId !== item.taxRateId ||
    a.takeoutTaxRateId !== item.takeoutTaxRateId ||
    a.priceYen !== item.priceYen ||
    a.nameJa !== item.name.ja ||
    a.nameEn !== item.name.en
  );
}

export default function AdminMenuPage() {
  const t = useTranslations();
  const locale = useLocale();
  const [menu, setMenu] = useState<StaffMenuResponse | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      staffApi
        .get<StaffMenuResponse>("/menu")
        .then((m) => {
          setMenu(m);
          return m;
        })
        .catch((err: unknown) => {
          setError(t(errorKey(err)));
          return null;
        }),
    [t],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(t(errorKey(err)));
    }
    await load();
  }

  const items = menu?.categories.flatMap((c) => c.items) ?? [];
  const editing =
    editor?.mode === "edit" ? (items.find((i) => i.id === editor.itemId) ?? null) : null;

  return (
    <>
      <PageHeader title={t("adminMenu.title")}>
        <Button
          variant="dark"
          className="h-11 px-4"
          onClick={() => setEditor({ session: ++editorSessions, mode: "add" })}
        >
          + {t("adminMenu.addItem")}
        </Button>
        <LangToggle />
      </PageHeader>
      <section className="min-h-0 flex-1 overflow-y-auto bg-canvas p-4 sm:p-6">
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
                    <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:gap-4">
                      <MenuItemImage
                        image={i.image}
                        name={pickName(i.name, locale)}
                        className="size-14 rounded-[10px]"
                        letterClassName="text-[20px]"
                      />
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
                          {!i.image && <span className="ml-2">· {t("adminMenu.photo.none")}</span>}
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
                      <Button
                        className="h-9 px-3 text-[13px]"
                        aria-label={t("adminMenu.editNamed", { name: pickName(i.name, locale) })}
                        onClick={() =>
                          setEditor({ session: ++editorSessions, mode: "edit", itemId: i.id })
                        }
                      >
                        {t("adminMenu.edit")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
      {editor && menu && (editor.mode === "add" || editing) && (
        <ItemDialog
          key={editor.session}
          menu={menu}
          item={editing}
          onClose={() => setEditor(null)}
          onSaved={async (itemId, photoFailed) => {
            const fresh = await load();
            // The item was saved but its photo was not: keep the dialog open on that item so it can be retried.
            if (photoFailed && fresh) setEditor({ session: editor.session, mode: "edit", itemId });
            else setEditor(null);
          }}
        />
      )}
    </>
  );
}

function ItemDialog({
  menu,
  item,
  onClose,
  onSaved,
}: {
  menu: StaffMenuResponse;
  item: MenuItemDto | null;
  onClose: () => void;
  onSaved: (itemId: string, photoFailed: boolean) => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [photo, setPhoto] = useState<PhotoChange>({ kind: "keep" });
  const [progress, setProgress] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameForAlt, setNameForAlt] = useState(item ? pickName(item.name, locale) : "");

  async function save(e: FormSubmitEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setError(null);

    let itemId = item?.id ?? null;
    try {
      await resolveTaxRate(form, "taxRateId");
      await resolveTaxRate(form, "takeoutTaxRateId");
      const fields = readFields(form);
      if (!item) {
        itemId = (await staffApi.send<{ id: string }>("POST", "/menu/items", fields)).id;
      } else if (fieldsChanged(fields, item)) {
        await staffApi.send("PUT", `/menu/items/${item.id}`, {
          ...fields,
          // Values this dialog does not edit are sent unchanged.
          code: item.code,
          descriptionJa: item.description.ja,
          descriptionEn: item.description.en,
          sortOrder: item.sortOrder,
          version: item.version,
        });
      }
    } catch (err) {
      setError(t(errorKey(err)));
      setSaving(false);
      return;
    }
    if (!itemId) return;

    try {
      if (photo.kind === "set") {
        setProgress(0);
        await staffApi.upload(`/menu/items/${itemId}/image`, photo.file, photo.contentType, (p) =>
          setProgress(p),
        );
      } else if (photo.kind === "remove") {
        await staffApi.send("DELETE", `/menu/items/${itemId}/image`);
      }
    } catch (err) {
      setError(t("adminMenu.photo.savedWithoutPhoto", { reason: t(photoErrorKey(err)) }));
      setProgress(null);
      setSaving(false);
      await onSaved(itemId, true);
      return;
    }
    setProgress(null);
    setSaving(false);
    await onSaved(itemId, false);
  }

  const inputClass = "mt-1 h-11 w-full rounded-[10px] border border-line px-3";
  return (
    <Dialog
      title={item ? t("adminMenu.editItem") : t("adminMenu.addItem")}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <MenuPhotoField
          current={item?.image ?? null}
          value={photo}
          onChange={setPhoto}
          name={nameForAlt}
          progress={progress}
          disabled={saving}
        />
        <label className="block text-[14px] font-medium">
          {t("adminMenu.nameJa")}
          <input
            name="nameJa"
            required
            maxLength={80}
            defaultValue={item?.name.ja ?? ""}
            onChange={(e) => {
              if (locale === "ja" || !nameForAlt) setNameForAlt(e.currentTarget.value);
            }}
            className={inputClass}
          />
        </label>
        <label className="block text-[14px] font-medium">
          {t("adminMenu.nameEn")}
          <input
            name="nameEn"
            maxLength={80}
            defaultValue={item?.name.en ?? ""}
            onChange={(e) => {
              if (locale === "en") setNameForAlt(e.currentTarget.value);
            }}
            className={inputClass}
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
            defaultValue={item?.priceYen}
            className={inputClass}
          />
        </label>
        <label className="block text-[14px] font-medium">
          {t("adminMenu.category")}
          <select name="categoryId" defaultValue={item?.categoryId} className={inputClass}>
            {menu.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {pickName(c.name, locale)}
              </option>
            ))}
          </select>
        </label>
        <TaxRateField
          name="taxRateId"
          label={t("adminMenu.tax")}
          rates={menu.taxRates}
          defaultValue={item?.taxRateId ?? menu.taxRates[0]?.id ?? CUSTOM_TAX}
          inputClass={inputClass}
        />
        <TaxRateField
          name="takeoutTaxRateId"
          label={t("adminMenu.takeoutTax")}
          rates={menu.taxRates}
          defaultValue={item?.takeoutTaxRateId ?? ""}
          sameAsDineIn
          inputClass={inputClass}
        />
        {error && <Banner>{error}</Banner>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button className="h-12" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="dark" className="h-12" disabled={saving}>
            {item ? t("common.save") : t("adminMenu.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A tax-rate select over the store's rates, plus "Other rate" which reveals a percentage input. */
function TaxRateField({
  name,
  label,
  rates,
  defaultValue,
  sameAsDineIn = false,
  inputClass,
}: {
  name: string;
  label: string;
  rates: StaffMenuResponse["taxRates"];
  defaultValue: string;
  sameAsDineIn?: boolean;
  inputClass: string;
}) {
  const t = useTranslations();
  const [value, setValue] = useState(defaultValue);
  return (
    <div className="space-y-2">
      <label className="block text-[14px] font-medium">
        {label}
        <select
          name={name}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          className={inputClass}
        >
          {sameAsDineIn && <option value="">{t("adminMenu.sameAsDineIn")}</option>}
          {rates.map((r) => (
            <option key={r.id} value={r.id}>
              {ratePercent(r.rateBp)}% ({r.code})
            </option>
          ))}
          <option value={CUSTOM_TAX}>{t("adminMenu.customTax")}</option>
        </select>
      </label>
      {value === CUSTOM_TAX && (
        <label className="block text-[13px] font-medium text-ink-2">
          {t("adminMenu.customTaxPercent")}
          <div className="relative">
            <input
              name={`${name}Custom`}
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.01}
              required
              autoFocus
              className={`${inputClass} pr-9`}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 mt-0.5 -translate-y-1/2 text-muted">
              %
            </span>
          </div>
          <span className="mt-1 block text-[12px] font-normal text-muted">
            {t("adminMenu.customTaxHint")}
          </span>
        </label>
      )}
    </div>
  );
}
