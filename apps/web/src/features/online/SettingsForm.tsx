"use client";
/**
 * Online ordering settings (Figma "Online & delivery"): ordering switches, link, times and minimums, weekly ordering
 * hours, delivery area (store location + distance tiers). One "Save changes" sends everything atomically with the
 * version that was loaded (a concurrent edit by another manager is rejected, not overwritten).
 */
import type {
  FeeTierDto,
  HoursWindowDto,
  OnlineSettingsDto,
  OnlineSettingsResponse,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Banner, Button, ConfirmButton, Spinner } from "../../components/ui";
import { staffApi } from "../../lib/api";
import { formatYen } from "../../lib/format";
import { onlineErrorKey } from "./shared";

const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function SettingsForm() {
  const t = useTranslations();
  const locale = useLocale();
  const [data, setData] = useState<OnlineSettingsResponse | null>(null);
  const [s, setS] = useState<OnlineSettingsDto | null>(null);
  const [hours, setHours] = useState<HoursWindowDto[]>([]);
  const [tiers, setTiers] = useState<FeeTierDto[]>([]);
  const [msg, setMsg] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const apply = useCallback((r: OnlineSettingsResponse) => {
    setData(r);
    setS(r.settings);
    setHours(r.hours);
    setTiers(r.tiers);
  }, []);
  useEffect(() => {
    staffApi
      .get<OnlineSettingsResponse>("/online/settings")
      .then(apply)
      .catch((err: unknown) => setMsg({ tone: "error", text: t(onlineErrorKey(err)) }));
  }, [apply, t]);

  if (!data || !s)
    return msg ? <Banner>{msg.text}</Banner> : <Spinner label={t("common.loading")} />;
  const set = (patch: Partial<OnlineSettingsDto>) => setS({ ...s, ...patch });
  const link = `${typeof window === "undefined" ? "" : window.location.origin}/order/${data.link.token}`;
  const radius = tiers.reduce((m, x) => Math.max(m, x.maxDistanceM), 0);
  const hoursValid = hours.every((h) => TIME_RE.test(h.opensAt) && TIME_RE.test(h.closesAt));

  async function save() {
    if (!data || !s) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await staffApi.send<OnlineSettingsResponse>("PUT", "/online/settings", {
        version: data.version,
        settings: s,
        hours,
        tiers: [...tiers].sort((a, b) => a.maxDistanceM - b.maxDistanceM),
      });
      apply(r);
      setMsg({ tone: "ok", text: t("online.saved") });
    } catch (err) {
      setMsg({ tone: "error", text: t(onlineErrorKey(err)) });
    } finally {
      setBusy(false);
    }
  }

  async function reissue() {
    try {
      const r = await staffApi.send<{ token: string }>("POST", "/online/link/rotate");
      if (data) setData({ ...data, link: { token: r.token, issuedAt: new Date().toISOString() } });
    } catch (err) {
      setMsg({ tone: "error", text: t(onlineErrorKey(err)) });
    }
  }

  return (
    <div className="space-y-5">
      <div className="sticky top-0 z-10 -mx-6 -mt-6 flex items-center gap-3 border-b border-line-2 bg-canvas/95 px-6 py-3 backdrop-blur">
        {msg && (
          <div className="min-w-0 flex-1">
            <Banner tone={msg.tone}>{msg.text}</Banner>
          </div>
        )}
        <Button
          variant="brand"
          className="ml-auto h-11 px-5"
          disabled={busy || !hoursValid}
          onClick={() => void save()}
        >
          {t("online.save")}
        </Button>
      </div>

      <Card title={t("online.settingsTitle")}>
        <Toggle
          label={t("online.takeOrders")}
          hint={t("online.takeOrdersHint")}
          checked={s.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        <Toggle
          label={t("online.pause")}
          hint={t("online.pauseHint")}
          checked={s.paused}
          onChange={(v) => set({ paused: v })}
        />
        <Toggle
          label={t("online.pickup")}
          hint={data.features.pickup ? undefined : t("online.notInPlan")}
          checked={s.pickupEnabled}
          disabled={!data.features.pickup}
          onChange={(v) => set({ pickupEnabled: v })}
        />
        <Toggle
          label={t("online.delivery")}
          hint={data.features.delivery ? t("online.deliveryHint") : t("online.notInPlan")}
          checked={s.deliveryEnabled}
          disabled={!data.features.delivery}
          onChange={(v) => set({ deliveryEnabled: v })}
        />
        {s.deliveryEnabled && !data.geocoderEnabled && (
          <Banner tone="info">{t("online.geocoderOff")}</Banner>
        )}
        <Toggle
          label={t("online.payAtHandover")}
          hint={t("online.payAtHandoverHint")}
          checked={s.payAtHandoverEnabled}
          onChange={(v) => set({ payAtHandoverEnabled: v })}
        />

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <input
            readOnly
            value={link}
            aria-label={t("online.link")}
            className="h-12 min-w-0 flex-1 rounded-[10px] border border-line bg-panel px-3 text-[14px]"
          />
          <Button
            className="h-12 px-4"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? t("online.copied") : t("online.copyLink")}
          </Button>
          <ConfirmButton
            label={t("online.reissueLink")}
            message={t("online.reissueConfirm")}
            confirmLabel={t("common.confirm")}
            cancelLabel={t("common.cancel")}
            onConfirm={() => void reissue()}
            className="h-12 px-4"
          />
        </div>
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-[14px] font-semibold text-brand"
        >
          {t("online.openStorefront")}
        </a>

        <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-3">
          <NumberField
            label={t("online.prepTime")}
            value={s.pickupPrepMinutes}
            min={5}
            max={240}
            onChange={(v) => set({ pickupPrepMinutes: v })}
          />
          <NumberField
            label={t("online.slotEvery")}
            value={s.pickupSlotMinutes}
            min={5}
            max={120}
            onChange={(v) => set({ pickupSlotMinutes: v })}
          />
          <NumberField
            label={t("online.minOrder")}
            value={s.minOrderYen}
            min={0}
            max={1_000_000}
            onChange={(v) => set({ minOrderYen: v })}
          />
          <NumberField
            label={t("online.daysAhead")}
            value={s.pickupDaysAhead}
            min={0}
            max={6}
            onChange={(v) => set({ pickupDaysAhead: v })}
          />
          <NumberField
            label={t("online.deliveryPrep")}
            value={s.deliveryPrepMinutes}
            min={10}
            max={240}
            onChange={(v) => set({ deliveryPrepMinutes: v })}
          />
        </div>
        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-[14px] font-semibold">{t("online.checkoutNote")}</legend>
          {(["ja", "en"] as const).map((l) => (
            <label key={l} className="block text-[13px] text-muted">
              {t(l === "ja" ? "online.checkoutNoteJa" : "online.checkoutNoteEn")}
              <textarea
                value={s.checkoutNote[l] ?? ""}
                maxLength={300}
                placeholder={t("online.checkoutNotePlaceholder")}
                onChange={(e) =>
                  set({ checkoutNote: { ...s.checkoutNote, [l]: e.target.value || null } })
                }
                className="mt-1 h-20 w-full rounded-[10px] border border-line px-3 py-2 text-[14px] text-ink"
              />
            </label>
          ))}
        </fieldset>
      </Card>

      <Card title={t("online.hours")} hint={t("online.hoursHint")}>
        <ul className="divide-y divide-line-soft">
          {WEEK.map((day) => {
            const windows = hours.map((h, i) => ({ h, i })).filter((x) => x.h.weekday === day);
            return (
              <li key={day} className="flex flex-wrap items-center gap-2 py-2">
                <span className="w-10 font-semibold">{t(`weekdays.${String(day)}`)}</span>
                {windows.length === 0 && (
                  <span className="text-[13px] text-muted">{t("online.closed")}</span>
                )}
                {windows.map(({ h, i }) => (
                  <span key={i} className="flex items-center gap-1">
                    <TimeInput
                      value={h.opensAt}
                      onChange={(v) =>
                        setHours(hours.map((x, j) => (j === i ? { ...x, opensAt: v } : x)))
                      }
                    />
                    –
                    <TimeInput
                      value={h.closesAt}
                      onChange={(v) =>
                        setHours(hours.map((x, j) => (j === i ? { ...x, closesAt: v } : x)))
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setHours(hours.filter((_, j) => j !== i))}
                      className="px-2 text-[12px] font-semibold text-muted hover:text-brand"
                    >
                      {t("online.remove")}
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setHours([...hours, { weekday: day, opensAt: "11:00", closesAt: "14:00" }])
                  }
                  className="ml-auto text-[13px] font-semibold text-brand"
                >
                  {t("online.addWindow")}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title={t("online.deliveryArea")} hint={t("online.deliveryAreaHint")}>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[220px_1fr]">
          <RadiusPicture tiers={tiers} />
          <div className="space-y-3">
            <fieldset className="grid grid-cols-2 gap-3">
              <legend className="mb-1 text-[14px] font-semibold">
                {t("online.storeLocation")}
              </legend>
              {(["latitude", "longitude"] as const).map((k) => (
                <label key={k} className="block text-[13px] text-muted">
                  {t(`online.${k}`)}
                  <input
                    type="number"
                    step="0.000001"
                    value={s.storeLocation?.[k] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      const cur = s.storeLocation ?? { latitude: 0, longitude: 0 };
                      set({ storeLocation: v === null ? null : { ...cur, [k]: v } });
                    }}
                    className="mt-1 h-11 w-full rounded-[10px] border border-line px-3 text-ink"
                  />
                </label>
              ))}
            </fieldset>
            <p className="flex items-baseline justify-between text-[14px] font-semibold">
              {t("online.maxRadius")}
              <span className="text-[24px] font-bold">{(radius / 1000).toFixed(1)} km</span>
            </p>
            <table className="w-full overflow-hidden rounded-[10px] border border-line text-[14px]">
              <thead className="bg-panel text-left text-[12px] text-muted">
                <tr>
                  <th className="px-3 py-2">{t("online.tierDistance")}</th>
                  <th className="px-3 py-2">{t("online.tierFee")}</th>
                  <th className="px-3 py-2">{t("online.tierMin")}</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {tiers.map((tier, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        step="0.1"
                        min={0.1}
                        max={50}
                        value={tier.maxDistanceM / 1000}
                        aria-label={t("online.tierDistance")}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((x, j) =>
                              j === i
                                ? { ...x, maxDistanceM: Math.round(Number(e.target.value) * 1000) }
                                : x,
                            ),
                          )
                        }
                        className="h-10 w-24 rounded-[8px] border border-line px-2"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min={0}
                        value={tier.feeYen}
                        aria-label={t("online.tierFee")}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((x, j) =>
                              j === i ? { ...x, feeYen: Math.floor(Number(e.target.value)) } : x,
                            ),
                          )
                        }
                        className="h-10 w-24 rounded-[8px] border border-line px-2"
                      />
                      <span className="ml-2 text-[12px] text-muted">
                        {tier.feeYen === 0 ? t("online.free") : formatYen(tier.feeYen, locale)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        min={0}
                        value={tier.minOrderYen}
                        aria-label={t("online.tierMin")}
                        onChange={(e) =>
                          setTiers(
                            tiers.map((x, j) =>
                              j === i
                                ? { ...x, minOrderYen: Math.floor(Number(e.target.value)) }
                                : x,
                            ),
                          )
                        }
                        className="h-10 w-28 rounded-[8px] border border-line px-2"
                      />
                    </td>
                    <td className="px-2 text-right">
                      <button
                        type="button"
                        onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                        className="text-[12px] font-semibold text-muted hover:text-brand"
                      >
                        {t("online.remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              disabled={tiers.length >= 10}
              onClick={() =>
                setTiers([...tiers, { maxDistanceM: radius + 1000, feeYen: 0, minOrderYen: 0 }])
              }
              className="text-[13px] font-semibold text-brand disabled:opacity-40"
            >
              {t("online.addTier")}
            </button>
            <p className="text-[13px] text-muted">{t("online.areaNote")}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-[16px] border border-line bg-white p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[18px] font-bold">{title}</h2>
        {hint && <p className="text-[13px] text-muted">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`flex items-start gap-4 ${disabled ? "opacity-50" : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-8 w-14 shrink-0 rounded-full transition-colors ${checked ? "bg-brand" : "bg-line"}`}
      >
        <span
          className={`absolute top-1 size-6 rounded-full bg-white shadow transition-all ${checked ? "left-7" : "left-1"}`}
        />
      </button>
      <span>
        <span className="block text-[15px] font-semibold">{label}</span>
        {hint && <span className="block text-[13px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-[13px] font-medium text-ink-2">
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) =>
          onChange(Math.min(max, Math.max(min, Math.floor(Number(e.target.value) || 0))))
        }
        className="mt-1 h-12 w-full rounded-[10px] border border-line px-3 text-[15px] text-ink"
      />
    </label>
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ok = TIME_RE.test(value);
  return (
    <input
      value={value}
      inputMode="numeric"
      maxLength={5}
      placeholder="11:00"
      aria-invalid={!ok}
      onChange={(e) => onChange(e.target.value)}
      className={`h-10 w-[72px] rounded-[8px] border px-2 text-center tabular-nums ${ok ? "border-line" : "border-brand bg-brand-tint"}`}
    />
  );
}

/** Concentric radius rings like the Figma delivery-area card (illustrative, not a map). */
function RadiusPicture({ tiers }: { tiers: FeeTierDto[] }) {
  const max = tiers.reduce((m, x) => Math.max(m, x.maxDistanceM), 0) || 1;
  return (
    <div
      className="relative flex aspect-square items-center justify-center rounded-[12px] bg-chip"
      aria-hidden
    >
      {[...tiers]
        .sort((a, b) => b.maxDistanceM - a.maxDistanceM)
        .map((t, i) => (
          <span
            key={t.maxDistanceM}
            className={`absolute rounded-full border-2 ${i === 0 ? "border-brand bg-brand-tint" : "border-dashed border-brand-dark"}`}
            style={{
              width: `${String((t.maxDistanceM / max) * 80)}%`,
              height: `${String((t.maxDistanceM / max) * 80)}%`,
            }}
          />
        ))}
      <span className="relative size-3 rounded-full bg-ink ring-4 ring-white" />
    </div>
  );
}
