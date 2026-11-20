"use client";
/** Basic printable receipt from the immutable receipt snapshot. Layout pending the approved receipt spec. */
import type { ReceiptDto } from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Banner, Button, Spinner } from "../../../../components/ui";
import { errorKey, staffApi } from "../../../../lib/api";
import { formatDateTime, formatYen, pickSnapshotName, ratePercent } from "../../../../lib/format";

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations();
  const locale = useLocale();
  const [receipt, setReceipt] = useState<ReceiptDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    staffApi
      .get<ReceiptDto>(`/receipts/${id}`)
      .then(setReceipt)
      .catch((err: unknown) => {
        setError(t(errorKey(err)));
      });
  }, [id, t]);
  if (error)
    return (
      <div className="p-6">
        <Banner>{error}</Banner>
      </div>
    );
  if (!receipt) return <Spinner label={t("common.loading")} />;
  const b = receipt.body;
  return (
    <main className="flex min-h-full flex-col items-center gap-4 p-6">
      <div className="no-print flex gap-2">
        <Link
          href="/tables"
          className="flex h-11 items-center rounded-[12px] border border-line bg-white px-4 font-semibold"
        >
          {t("checkout.backToTables")}
        </Link>
        <Button variant="dark" className="h-11 px-5" onClick={() => window.print()}>
          {t("receipt.print")}
        </Button>
      </div>
      <article
        className="w-[320px] bg-white p-5 font-mono text-[13px] leading-relaxed text-black"
        aria-label={t("receipt.title")}
      >
        <h1 className="text-center text-[16px] font-bold">{b.locationName}</h1>
        {b.header && <p className="text-center whitespace-pre-line">{b.header}</p>}
        <p className="mt-2 text-center">{t("receipt.title")}</p>
        <div className="mt-2 flex justify-between">
          <span>{formatDateTime(b.issuedAt, locale, b.timeZone)}</span>
          <span>{t("receipt.no", { no: receipt.receiptNo })}</span>
        </div>
        <p>
          {t("receipt.table", { name: b.tableName })} · #{String(b.slipNo).padStart(4, "0")}
        </p>
        <hr className="my-2 border-dashed border-black" />
        {b.lines.map((l, i) => (
          <div key={i}>
            <div className="flex justify-between">
              <span>{pickSnapshotName(l.nameJa, l.nameEn, locale)}</span>
              <span>{formatYen(l.lineTotalYen, locale)}</span>
            </div>
            <div className="pl-3 text-[11px]">
              {formatYen(l.unitPriceYen, locale)} × {l.quantity}
            </div>
          </div>
        ))}
        <hr className="my-2 border-dashed border-black" />
        <div className="flex justify-between">
          <span>{t("receipt.subtotal")}</span>
          <span>{formatYen(b.subtotalYen, locale)}</span>
        </div>
        {b.taxBreakdown.map((x) => (
          <div key={x.rateBp} className="flex justify-between text-[12px]">
            <span>
              {b.pricesIncludeTax
                ? t("receipt.taxIncluded", { rate: ratePercent(x.rateBp) })
                : t("receipt.tax", { rate: ratePercent(x.rateBp) })}
            </span>
            <span>{formatYen(x.taxYen, locale)}</span>
          </div>
        ))}
        <div className="mt-1 flex justify-between text-[16px] font-bold">
          <span>{t("receipt.total")}</span>
          <span>{formatYen(b.totalYen, locale)}</span>
        </div>
        <div className="flex justify-between">
          <span>{t("receipt.cash")}</span>
          <span>{formatYen(b.payment.amountReceivedYen, locale)}</span>
        </div>
        <div className="flex justify-between">
          <span>{t("receipt.change")}</span>
          <span>{formatYen(b.payment.changeYen, locale)}</span>
        </div>
        {b.footer && <p className="mt-3 text-center whitespace-pre-line">{b.footer}</p>}
        <p className="mt-3 text-center text-[10px] text-gray-500">{t("receipt.pendingSpec")}</p>
      </article>
    </main>
  );
}
