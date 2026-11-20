"use client";
/** Table management + printable QR codes (Figma "Table QR codes"). QR images are generated in the browser. */
import type { AdminTableDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { LangToggle } from "../../../../../components/LangToggle";
import { PageHeader } from "../../../../../components/PageHeader";
import { Banner, Button, ConfirmButton, Dialog, Spinner } from "../../../../../components/ui";
import { errorKey, staffApi } from "../../../../../lib/api";
import { formatDateTime } from "../../../../../lib/format";
import { type FormSubmitEvent, field } from "../../../../../lib/forms";

interface QrInfo {
  token: string;
  issuedAt: string;
  url: string;
  image: string;
}

async function qrFor(tableId: string): Promise<QrInfo> {
  const { token, issuedAt } = await staffApi.get<{ token: string; issuedAt: string }>(
    `/tables/${tableId}/qr`,
  );
  const url = `${window.location.origin}/t/${token}`;
  return {
    token,
    issuedAt,
    url,
    image: await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" }),
  };
}

export default function AdminTablesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const [tables, setTables] = useState<AdminTableDto[] | null>(null);
  const [qrs, setQrs] = useState<Record<string, QrInfo>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [printOnly, setPrintOnly] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await staffApi.get<{ tables: AdminTableDto[] }>("/tables");
      setTables(r.tables);
      const entries = await Promise.all(
        r.tables.map(async (x) => [x.id, await qrFor(x.id)] as const),
      );
      setQrs(Object.fromEntries(entries));
    } catch (err) {
      setError(t(errorKey(err)));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const selected = tables?.find((x) => x.id === selectedId) ?? null;
  const selectedQr = selected ? qrs[selected.id] : undefined;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(t(errorKey(err)));
    }
    await load();
  }

  async function create(e: FormSubmitEvent) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setAdding(false);
    await run(() =>
      staffApi.send("POST", "/tables", {
        name: field(f, "name"),
        capacity: Number(field(f, "capacity")),
        area: field(f, "area") || null,
      }),
    );
  }

  function print(ids: string[]) {
    setPrintOnly(ids);
    setTimeout(() => {
      window.print();
    }, 50);
  }

  return (
    <>
      <PageHeader title={t("adminTables.title")}>
        <span className="mr-auto hidden text-[14px] text-muted md:block">
          {t("adminTables.subtitle")}
        </span>
        <Button className="h-11 px-4" onClick={() => setAdding(true)}>
          + {t("adminTables.addTable")}
        </Button>
        <Button
          variant="brand"
          className="h-11 px-4"
          onClick={() => print((tables ?? []).filter((x) => x.isActive).map((x) => x.id))}
        >
          {t("adminTables.printAll")}
        </Button>
        <LangToggle />
      </PageHeader>
      <div className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-y-auto bg-canvas p-6">
          {error && (
            <div className="mb-4">
              <Banner>{error}</Banner>
            </div>
          )}
          {!tables ? (
            <Spinner label={t("common.loading")} />
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 print:grid-cols-3">
              {tables.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setSelectedId(x.id)}
                  aria-pressed={x.id === selectedId}
                  className={`flex flex-col items-center rounded-[12px] border-2 bg-white p-4 break-inside-avoid ${x.id === selectedId ? "border-brand" : "border-line"} ${x.isActive ? "" : "opacity-50"} ${printOnly && !printOnly.includes(x.id) ? "print:hidden" : ""}`}
                >
                  {qrs[x.id] ? (
                    <img src={qrs[x.id]?.image} alt={`QR ${x.name}`} className="size-[120px]" />
                  ) : (
                    <span className="size-[120px] bg-chip" />
                  )}
                  <span className="mt-1 text-[18px] font-bold">{x.name}</span>
                  <span className="text-[13px] text-muted">
                    {x.isActive
                      ? t("common.seats", { count: x.capacity })
                      : t("adminTables.inactive")}
                  </span>
                  <span className="hidden text-[11px] print:block">
                    {t("adminTables.scanToOrder")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        <aside className="no-print hidden w-[340px] shrink-0 overflow-y-auto border-l border-line-2 bg-white p-5 lg:block">
          {selected && selectedQr ? (
            <div className="space-y-3 rounded-[12px] border border-line p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[18px] font-bold">{selected.name}</h2>
                <span className="text-[12px] text-muted">
                  {t("adminTables.issued", { date: formatDateTime(selectedQr.issuedAt, locale) })}
                </span>
              </div>
              <p className="text-[13px] font-semibold text-ink-2">{t("adminTables.menuLink")}</p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={selectedQr.url}
                  aria-label={t("adminTables.menuLink")}
                  className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-panel px-3 text-[12px]"
                />
                <Button
                  className="h-11 px-3"
                  onClick={() => {
                    void navigator.clipboard.writeText(selectedQr.url).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? t("adminTables.copied") : t("adminTables.copy")}
                </Button>
              </div>
              <p className="text-[12px] text-muted">{t("adminTables.linkHint")}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="dark" className="h-12" onClick={() => print([selected.id])}>
                  {t("adminTables.print")}
                </Button>
                <ConfirmButton
                  className="h-12"
                  label={t("adminTables.reissue")}
                  message={t("adminTables.reissueConfirm", { table: selected.name })}
                  confirmLabel={t("adminTables.reissue")}
                  cancelLabel={t("common.cancel")}
                  onConfirm={() =>
                    void run(() => staffApi.send("POST", `/tables/${selected.id}/qr/rotate`))
                  }
                />
              </div>
              <a
                href={selectedQr.url}
                target="_blank"
                rel="noreferrer"
                className="block text-[13px] font-semibold text-brand"
              >
                {t("adminTables.previewGuest")} →
              </a>
              <Button
                variant="ghost"
                className="h-10 w-full text-[13px]"
                onClick={() =>
                  void run(() =>
                    staffApi.send("PATCH", `/tables/${selected.id}`, {
                      version: selected.version,
                      isActive: !selected.isActive,
                    }),
                  )
                }
              >
                {selected.isActive ? t("adminTables.deactivate") : t("adminTables.activate")}
              </Button>
            </div>
          ) : (
            <p className="text-[14px] text-muted">{t("tables.selectTable")}</p>
          )}
        </aside>
      </div>
      {adding && (
        <Dialog title={t("adminTables.addTable")} onClose={() => setAdding(false)}>
          <form onSubmit={(e) => void create(e)} className="space-y-3">
            <label className="block text-[14px] font-medium">
              {t("adminTables.name")}
              <input
                name="name"
                required
                maxLength={20}
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              />
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminTables.capacity")}
              <input
                name="capacity"
                type="number"
                min={1}
                max={50}
                defaultValue={2}
                required
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              />
            </label>
            <label className="block text-[14px] font-medium">
              {t("adminTables.area")}
              <input
                name="area"
                maxLength={40}
                className="mt-1 h-11 w-full rounded-[10px] border border-line px-3"
              />
            </label>
            <Button type="submit" variant="dark" className="h-12 w-full">
              {t("adminTables.create")}
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}
