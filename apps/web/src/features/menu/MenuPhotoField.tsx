"use client";
/**
 * "Menu item photo" control for the Add/Edit Menu Item dialog: click or drag-and-drop to choose, instant local
 * preview, replace, remove (undoable until saved), upload progress and validation feedback.
 *
 * It only SELECTS a change; the dialog uploads it on Save (the item must exist first). Client checks mirror the
 * server rules for instant feedback; the server re-validates everything.
 */
import {
  MENU_IMAGE_ACCEPTED_TYPES,
  MENU_IMAGE_MAX_BYTES,
  type MenuImageDto,
  type MenuImageSourceType,
} from "@restaurant-platform/contracts";
import { useTranslations } from "next-intl";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { MenuItemImage } from "../../components/MenuItemImage";
import { Button } from "../../components/ui";
import { ApiError } from "../../lib/api";

export type PhotoChange =
  | { kind: "keep" }
  | { kind: "set"; file: File; contentType: MenuImageSourceType; previewUrl: string }
  | { kind: "remove" };

const MAX_MB = Math.round(MENU_IMAGE_MAX_BYTES / (1024 * 1024));

/** Identifies the real file type from its first bytes (browsers guess MIME types from the file name). */
async function sniff(file: File): Promise<MenuImageSourceType | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v))
    return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Maps an upload error to a message key under `adminMenu.photo.errors`. */
export function photoErrorKey(err: unknown): string {
  const base = "adminMenu.photo.errors.";
  if (!(err instanceof ApiError)) return `${base}generic`;
  switch (err.code) {
    case "image_too_large":
      return `${base}tooLarge`;
    case "unsupported_image_type":
      return `${base}unsupported`;
    case "invalid_image":
    case "image_missing":
      return `${base}invalid`;
    case "image_dimensions_invalid":
      return `${base}dimensions`;
    case "image_processing_busy":
      return `${base}busy`;
    case "rate_limited":
      return `${base}rateLimited`;
    case "storage_unavailable":
    case "image_upload_expired":
      return `${base}storage`;
    case "network_error":
      return "errors.network";
    case "forbidden":
      return "errors.forbidden";
    default:
      return `${base}generic`;
  }
}

export function MenuPhotoField({
  current,
  value,
  onChange,
  name,
  progress,
  disabled = false,
}: {
  /** The item's saved photo (null for new items or items without one). */
  current: MenuImageDto | null;
  value: PhotoChange;
  onChange: (next: PhotoChange) => void;
  /** Localized item name, for alt text. */
  name: string;
  /** Upload progress 0..1 while saving, otherwise null. */
  progress: number | null;
  disabled?: boolean;
}) {
  const t = useTranslations("adminMenu.photo");
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Release the local preview's object URL when it is replaced or the dialog closes.
  const previewUrl = value.kind === "set" ? value.previewUrl : null;
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  async function accept(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MENU_IMAGE_MAX_BYTES) {
      setError(t("errors.tooLarge", { maxMb: MAX_MB }));
      return;
    }
    const type = await sniff(file);
    if (!type || !MENU_IMAGE_ACCEPTED_TYPES.includes(type)) {
      setError(t("errors.unsupported"));
      return;
    }
    onChange({ kind: "set", file, contentType: type, previewUrl: URL.createObjectURL(file) });
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    void accept(e.dataTransfer.files[0]);
  }
  const choose = () => inputRef.current?.click();

  const shown: MenuImageDto | null =
    value.kind === "set"
      ? {
          url: value.previewUrl,
          thumbUrl: value.previewUrl,
          width: 320,
          height: 320,
          thumbWidth: 320,
          thumbHeight: 320,
        }
      : value.kind === "remove"
        ? null
        : current;
  const uploading = progress !== null;

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-[14px] font-medium">{t("label")}</legend>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={MENU_IMAGE_ACCEPTED_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-describedby={hintId}
        onChange={(e) => {
          void accept(e.currentTarget.files?.[0]);
          e.currentTarget.value = ""; // allow choosing the same file again
        }}
      />

      {shown ? (
        <div
          className={`flex items-center gap-4 rounded-[12px] border p-3 ${dragging ? "border-brand bg-brand-tint" : "border-line"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <MenuItemImage
            image={shown}
            name={name || t("preview")}
            rendition="main"
            className="size-24 rounded-[10px] sm:size-28"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {value.kind === "set" && <p className="text-[12px] text-muted">{t("newSelected")}</p>}
            <div className="flex flex-wrap gap-2">
              <Button className="h-10 px-3 text-[13px]" onClick={choose}>
                {t("replace")}
              </Button>
              <Button
                className="h-10 px-3 text-[13px]"
                onClick={() => {
                  setError(null);
                  onChange(
                    value.kind === "set" && !current ? { kind: "keep" } : { kind: "remove" },
                  );
                }}
              >
                {t("remove")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={choose}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          aria-describedby={hintId}
          className={`flex w-full flex-col items-center justify-center gap-1 rounded-[12px] border-2 border-dashed px-4 py-6 text-center transition-colors ${dragging ? "border-brand bg-brand-tint" : "border-line bg-canvas hover:bg-chip"}`}
        >
          <span className="text-[14px] font-semibold text-ink-2">{t("choose")}</span>
          <span className="text-[12px] text-muted">{t("drop")}</span>
        </button>
      )}

      {value.kind === "remove" && current && (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted" role="status">
          {t("willRemove")}
          <button
            type="button"
            className="font-semibold text-brand underline"
            onClick={() => onChange({ kind: "keep" })}
          >
            {t("undoRemove")}
          </button>
        </p>
      )}

      <p id={hintId} className="text-[12px] text-muted">
        {t("hint", { maxMb: MAX_MB })}
      </p>

      {uploading && (
        <div className="space-y-1" role="status" aria-live="polite">
          <div
            role="progressbar"
            aria-label={t("uploadingLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-2 w-full overflow-hidden rounded-full bg-chip"
          >
            <div
              className="h-full rounded-full bg-brand transition-[width]"
              style={{ width: `${String(Math.round(progress * 100))}%` }}
            />
          </div>
          <p className="text-[12px] text-muted">
            {progress < 1
              ? t("uploading", { percent: Math.round(progress * 100) })
              : t("processing")}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[13px] font-medium text-brand-dark">
          {error}
        </p>
      )}
    </fieldset>
  );
}
