"use client";
/**
 * The one way every screen (admin menu, POS, table QR menu, online ordering) shows a menu item's photo.
 * Uses the small thumbnail rendition, lazy-loads, never stretches (object-cover crops to the box), and falls back
 * to the brand-tinted initial placeholder when an item has no photo or it fails to load.
 */
import type { MenuImageDto } from "@restaurant-platform/contracts";
import { useState } from "react";

export function MenuItemImage({
  image,
  name,
  className,
  letterClassName = "text-[24px]",
  rendition = "thumb",
  sizes,
  eager = false,
  placeholder = "brand",
}: {
  image: MenuImageDto | null;
  /** Localized item name: used as alt text and for the placeholder initial. */
  name: string;
  /** Box size and shape, e.g. "size-[72px] rounded-[12px]". */
  className: string;
  letterClassName?: string;
  /** "main" only for large previews (admin editor); lists always use the thumbnail. */
  rendition?: "thumb" | "main";
  /**
   * Responsive large view: offers both renditions (`srcset`) and lets the browser pick by rendered width, so a phone
   * never downloads more than it shows. Example: "(min-width: 640px) 520px, 100vw".
   */
  sizes?: string;
  /** Load immediately (the one image visible on open, e.g. a detail sheet). */
  eager?: boolean;
  /** "neutral" = quiet surface tone (customer menus, where photos should carry the color). */
  placeholder?: "brand" | "neutral";
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = image ? (rendition === "main" ? image.url : image.thumbUrl) : null;
  const showImage = src !== null && failedUrl !== src;
  return (
    <span
      className={`relative block shrink-0 overflow-hidden ${placeholder === "neutral" ? "bg-chip" : "bg-brand-tint"} ${className}`}
    >
      {showImage && image ? (
        // Plain <img>: URLs are already optimized, immutable WebP renditions (no image proxy needed).
        <img
          src={src}
          alt={name}
          width={rendition === "main" ? image.width : image.thumbWidth}
          height={rendition === "main" ? image.height : image.thumbHeight}
          {...(sizes
            ? {
                srcSet: `${image.thumbUrl} ${String(image.thumbWidth)}w, ${image.url} ${String(image.width)}w`,
                sizes,
              }
            : {})}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onError={() => setFailedUrl(src)}
          className="size-full object-cover transition-transform duration-300 ease-out"
        />
      ) : (
        <span
          aria-hidden
          className={`flex size-full items-center justify-center font-bold ${placeholder === "neutral" ? "text-placeholder" : "text-brand"} ${letterClassName}`}
        >
          {name.slice(0, 1)}
        </span>
      )}
    </span>
  );
}
