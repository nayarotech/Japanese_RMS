"use client";
/**
 * Storefront settings (storefront.manage): how this branch presents itself on the table-QR and online-ordering pages.
 * Restaurant-level only: the partner brand (name, marks, support contact, legal links) is not editable here.
 * Text is saved as plain text. Logo and cover upload immediately through the same validated, re-encoding image
 * pipeline as menu photos. Saving sends the version that was loaded, so a concurrent edit is never overwritten.
 */
import {
  MENU_IMAGE_ACCEPTED_TYPES,
  MENU_IMAGE_MAX_BYTES,
  type MenuImageDto,
  type OnlineSettingsResponse,
  STOREFRONT_MAX_FEATURED,
  type StaffMenuResponse,
  type StorefrontProfileDto,
  type StorefrontSettingsResponse,
} from "@restaurant-platform/contracts";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { LangToggle } from "../../../../../components/LangToggle";
import { MenuItemImage } from "../../../../../components/MenuItemImage";
import { PageHeader } from "../../../../../components/PageHeader";
import { Banner, Button, Spinner } from "../../../../../components/ui";
import { photoErrorKey } from "../../../../../features/menu/MenuPhotoField";
import { useStaff } from "../../../../../features/staff/StaffProvider";
import { ApiError, errorKey, staffApi } from "../../../../../lib/api";
import { formatYen, pickName } from "../../../../../lib/format";

type Draft = Omit<StorefrontProfileDto, "logo" | "cover">;

/** WCAG contrast against white (mirrors the API rule: accent colors carry white text). */
function contrastWithWhite(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
  return 1.05 / (l + 0.05);
}

const toDraft = (p: StorefrontProfileDto): Draft => ({
  displayName: p.displayName,
  description: p.description,
  announcement: p.announcement,
  phone: p.phone,
  address: p.address,
  accentColor: p.accentColor,
});

export default function StorefrontSettingsPage() {
  const t = useTranslations("storefrontAdmin");
  const tr = useTranslations();
  const locale = useLocale();
  const { can, hasFeature } = useStaff();
  const [data, setData] = useState<StorefrontSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [featured, setFeatured] = useState<string[]>([]);
  const [menu, setMenu] = useState<StaffMenuResponse | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = useCallback((r: StorefrontSettingsResponse) => {
    setData(r);
    setDraft(toDraft(r.profile));
    setFeatured(r.featuredItemIds);
  }, []);

  useEffect(() => {
    staffApi
      .get<StorefrontSettingsResponse>("/storefront")
      .then(apply)
      .catch((err: unknown) => setMsg({ tone: "error", text: tr(errorKey(err)) }));
    staffApi
      .get<StaffMenuResponse>("/menu")
      .then(setMenu)
      .catch(() => setMenu(null));
    if (can("online_settings.manage") && hasFeature("online_ordering"))
      staffApi
        .get<OnlineSettingsResponse>("/online/settings")
        .then((s) => setLink(`/order/${s.link.token}`))
        .catch(() => setLink(null));
  }, [apply, tr, can, hasFeature]);

  if (!data || !draft)
    return (
      <>
        <PageHeader title={t("title")}>
          <LangToggle />
        </PageHeader>
        <section className="flex-1 bg-canvas p-6">
          {msg ? <Banner>{msg.text}</Banner> : <Spinner label={tr("common.loading")} />}
        </section>
      </>
    );

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const accentOk = !draft.accentColor || contrastWithWhite(draft.accentColor) >= 4.5;
  const items = menu?.categories.flatMap((c) => c.items) ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));

  async function save() {
    if (!data || !draft) return;
    setSaving(true);
    setMsg(null);
    try {
      apply(
        await staffApi.send<StorefrontSettingsResponse>("PUT", "/storefront", {
          version: data.version,
          ...draft,
          featuredItemIds: featured,
        }),
      );
      setMsg({ tone: "ok", text: t("saved") });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setMsg({
        tone: "error",
        text:
          code === "accent_color_low_contrast"
            ? t("accentLowContrast")
            : code === "version_conflict"
              ? tr("errors.conflict")
              : tr(errorKey(err)),
      });
      if (code === "version_conflict")
        void staffApi.get<StorefrontSettingsResponse>("/storefront").then(apply);
    } finally {
      setSaving(false);
    }
  }

  const onImage = (kind: "logo" | "cover", image: MenuImageDto | null) =>
    setData({ ...data, profile: { ...data.profile, [kind]: image } });

  return (
    <>
      <PageHeader title={t("title")}>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="text-[14px] font-semibold text-brand"
          >
            {t("openStorefront")}
          </a>
        )}
        <LangToggle />
      </PageHeader>
      <section className="min-h-0 flex-1 overflow-y-auto bg-canvas p-4 sm:p-6">
        <div className="mx-auto max-w-[920px] space-y-5">
          <div className="sticky top-0 z-10 -mx-4 -mt-4 flex items-center gap-3 border-b border-line-2 bg-canvas/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mt-6 sm:px-6">
            <p className="min-w-0 flex-1 text-[13px] text-muted">{t("intro")}</p>
            <Button
              variant="brand"
              className="h-11 shrink-0 px-5"
              disabled={saving || !accentOk}
              onClick={() => void save()}
            >
              {saving ? tr("common.loading") : tr("common.save")}
            </Button>
          </div>
          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

          <Card title={t("identity")}>
            <TextField
              label={t("displayName")}
              hint={t("displayNameHint")}
              value={draft.displayName ?? ""}
              max={60}
              onChange={(v) => set({ displayName: v || null })}
            />
            <Bilingual
              label={t("description")}
              hint={t("descriptionHint")}
              value={draft.description}
              max={300}
              rows={3}
              onChange={(description) => set({ description })}
            />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <ImageField
                kind="logo"
                label={t("logo")}
                hint={t("logoHint")}
                image={data.profile.logo}
                onChange={(img) => onImage("logo", img)}
              />
              <ImageField
                kind="cover"
                label={t("cover")}
                hint={t("coverHint")}
                image={data.profile.cover}
                onChange={(img) => onImage("cover", img)}
              />
            </div>
          </Card>

          <Card title={t("announcementTitle")}>
            <Bilingual
              label={t("announcement")}
              hint={t("announcementHint")}
              value={draft.announcement}
              max={200}
              rows={2}
              onChange={(announcement) => set({ announcement })}
            />
          </Card>

          <Card title={t("contact")}>
            <TextField
              label={t("phone")}
              value={draft.phone ?? ""}
              max={20}
              inputMode="tel"
              onChange={(v) => set({ phone: v || null })}
            />
            <Bilingual
              label={t("address")}
              hint={t("addressHint")}
              value={draft.address}
              max={200}
              rows={1}
              onChange={(address) => set({ address })}
            />
          </Card>

          <Card title={t("accent")}>
            <p className="text-[13px] text-muted">{t("accentHint")}</p>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="color"
                aria-label={t("accent")}
                value={draft.accentColor ?? "#181d20"}
                onChange={(e) => set({ accentColor: e.target.value.toLowerCase() })}
                className="h-11 w-16 cursor-pointer rounded-[10px] border border-line bg-white p-1"
              />
              <input
                value={draft.accentColor ?? ""}
                placeholder={t("accentNone")}
                maxLength={7}
                aria-label={t("accentHex")}
                onChange={(e) => set({ accentColor: e.target.value.trim().toLowerCase() || null })}
                className="h-11 w-32 rounded-[10px] border border-line px-3 font-mono text-[14px]"
              />
              {draft.accentColor && (
                <span
                  className="rounded-[10px] px-4 py-2.5 text-[14px] font-bold text-white"
                  style={{
                    background: /^#[0-9a-f]{6}$/.test(draft.accentColor)
                      ? draft.accentColor
                      : undefined,
                  }}
                >
                  {t("accentPreview")}
                </span>
              )}
              <Button className="h-11 px-4" onClick={() => set({ accentColor: null })}>
                {t("accentReset")}
              </Button>
            </div>
            {!accentOk && (
              <p role="alert" className="text-[13px] font-semibold text-brand-dark">
                {t("accentLowContrast")}
              </p>
            )}
          </Card>

          <Card title={t("featured")}>
            <p className="text-[13px] text-muted">
              {t("featuredHint", { max: STOREFRONT_MAX_FEATURED })}
            </p>
            {featured.length > 0 && (
              <ol className="space-y-2">
                {featured.map((id, idx) => {
                  const i = byId.get(id);
                  const name = i ? pickName(i.name, locale) : t("featuredMissing");
                  return (
                    <li
                      key={id}
                      className="flex items-center gap-3 rounded-[12px] border border-line bg-white p-2.5"
                    >
                      <span className="w-5 text-center text-[13px] font-bold text-muted">
                        {idx + 1}
                      </span>
                      <MenuItemImage
                        image={i?.image ?? null}
                        name={name}
                        className="size-11 rounded-[8px]"
                        letterClassName="text-[16px]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                        {name}
                      </span>
                      <Button
                        className="h-9 w-9 text-[14px]"
                        aria-label={t("moveUp", { name })}
                        disabled={idx === 0}
                        onClick={() => {
                          const next = [...featured];
                          [next[idx - 1], next[idx]] = [
                            next[idx] as string,
                            next[idx - 1] as string,
                          ];
                          setFeatured(next);
                        }}
                      >
                        ↑
                      </Button>
                      <Button
                        className="h-9 w-9 text-[14px]"
                        aria-label={t("moveDown", { name })}
                        disabled={idx === featured.length - 1}
                        onClick={() => {
                          const next = [...featured];
                          [next[idx + 1], next[idx]] = [
                            next[idx] as string,
                            next[idx + 1] as string,
                          ];
                          setFeatured(next);
                        }}
                      >
                        ↓
                      </Button>
                      <Button
                        className="h-9 px-3 text-[13px]"
                        onClick={() => setFeatured(featured.filter((x) => x !== id))}
                      >
                        {t("unfeature")}
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
            {menu ? (
              <details className="rounded-[12px] border border-line bg-white">
                <summary className="cursor-pointer px-4 py-3 text-[14px] font-semibold">
                  {t("chooseFeatured")}
                </summary>
                <div className="max-h-[360px] space-y-3 overflow-y-auto px-4 pb-4">
                  {menu.categories.map((c) => (
                    <fieldset key={c.id}>
                      <legend className="mb-1 text-[12px] font-bold text-muted">
                        {pickName(c.name, locale)}
                      </legend>
                      {c.items
                        .filter((i) => i.isActive)
                        .map((i) => {
                          const checked = featured.includes(i.id);
                          return (
                            <label
                              key={i.id}
                              className="flex items-center gap-3 py-1.5 text-[14px]"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!checked && featured.length >= STOREFRONT_MAX_FEATURED}
                                onChange={(e) =>
                                  setFeatured(
                                    e.target.checked
                                      ? [...featured, i.id]
                                      : featured.filter((x) => x !== i.id),
                                  )
                                }
                                className="size-5 accent-[var(--color-brand)]"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {pickName(i.name, locale)}
                              </span>
                              <span className="text-muted tabular-nums">
                                {formatYen(i.priceYen, locale)}
                              </span>
                            </label>
                          );
                        })}
                    </fieldset>
                  ))}
                </div>
              </details>
            ) : (
              <p className="text-[13px] text-muted">{t("menuUnavailable")}</p>
            )}
          </Card>
        </div>
      </section>
    </>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-[16px] border border-line bg-white p-5">
      <h2 className="text-[18px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

function TextField({
  label,
  hint,
  value,
  max,
  inputMode,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  max: number;
  inputMode?: "tel";
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-[14px] font-medium">
      {label}
      <input
        value={value}
        maxLength={max}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-11 w-full rounded-[10px] border border-line px-3 text-[15px]"
      />
      {hint && <span className="mt-1 block text-[12px] font-normal text-muted">{hint}</span>}
    </label>
  );
}

function Bilingual({
  label,
  hint,
  value,
  max,
  rows,
  onChange,
}: {
  label: string;
  hint?: string;
  value: { ja: string | null; en: string | null };
  max: number;
  rows: number;
  onChange: (v: { ja: string | null; en: string | null }) => void;
}) {
  const t = useTranslations("storefrontAdmin");
  return (
    <fieldset>
      <legend className="text-[14px] font-medium">{label}</legend>
      <div className="mt-1 grid grid-cols-1 gap-3 md:grid-cols-2">
        {(["ja", "en"] as const).map((l) => (
          <label key={l} className="block text-[12px] text-muted">
            {t(l === "ja" ? "japanese" : "english")}
            <textarea
              rows={rows}
              value={value[l] ?? ""}
              maxLength={max}
              lang={l}
              onChange={(e) => onChange({ ...value, [l]: e.target.value || null })}
              className="mt-1 w-full resize-y rounded-[10px] border border-line px-3 py-2 text-[15px] text-ink"
            />
            <span className="block text-right tabular-nums">
              {(value[l] ?? "").length}/{max}
            </span>
          </label>
        ))}
      </div>
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
    </fieldset>
  );
}

/** Uploads immediately (the image pipeline validates, strips metadata and re-encodes). */
function ImageField({
  kind,
  label,
  hint,
  image,
  onChange,
}: {
  kind: "logo" | "cover";
  label: string;
  hint: string;
  image: MenuImageDto | null;
  onChange: (img: MenuImageDto | null) => void;
}) {
  const t = useTranslations("storefrontAdmin");
  const tr = useTranslations();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MENU_IMAGE_MAX_BYTES) {
      setError(
        tr("adminMenu.photo.errors.tooLarge", {
          maxMb: Math.round(MENU_IMAGE_MAX_BYTES / 1048576),
        }),
      );
      return;
    }
    const type = (MENU_IMAGE_ACCEPTED_TYPES as readonly string[]).includes(file.type)
      ? file.type
      : null;
    if (!type) {
      setError(tr("adminMenu.photo.errors.unsupported"));
      return;
    }
    try {
      setProgress(0);
      const r = await staffApi.upload<{ image: MenuImageDto }>(
        `/storefront/images/${kind}`,
        file,
        type,
        setProgress,
      );
      onChange(r.image);
    } catch (err) {
      setError(tr(photoErrorKey(err)));
    } finally {
      setProgress(null);
    }
  }

  async function remove() {
    setError(null);
    try {
      await staffApi.send("DELETE", `/storefront/images/${kind}`);
      onChange(null);
    } catch (err) {
      setError(tr(errorKey(err)));
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[14px] font-medium">{label}</p>
      <input
        ref={input}
        type="file"
        accept={MENU_IMAGE_ACCEPTED_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-describedby={hintId}
        onChange={(e) => {
          void upload(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
      <div className="flex items-center gap-3 rounded-[12px] border border-line p-3">
        <MenuItemImage
          image={image}
          name={label}
          rendition="main"
          className={
            kind === "logo"
              ? "size-20 rounded-[14px] [&_img]:object-contain"
              : "aspect-[16/7] w-40 rounded-[10px]"
          }
          letterClassName="text-[18px]"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-10 px-3 text-[13px]"
            disabled={progress !== null}
            onClick={() => input.current?.click()}
          >
            {image ? t("replaceImage") : t("uploadImage")}
          </Button>
          {image && (
            <Button
              className="h-10 px-3 text-[13px]"
              disabled={progress !== null}
              onClick={() => void remove()}
            >
              {t("removeImage")}
            </Button>
          )}
        </div>
      </div>
      <p id={hintId} className="text-[12px] text-muted">
        {hint}
      </p>
      {progress !== null && (
        <p role="status" className="text-[12px] text-muted">
          {progress < 1
            ? tr("adminMenu.photo.uploading", { percent: Math.round(progress * 100) })
            : tr("adminMenu.photo.processing")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] font-medium text-brand-dark">
          {error}
        </p>
      )}
    </div>
  );
}
