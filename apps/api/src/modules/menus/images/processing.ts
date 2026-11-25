/**
 * Menu photo validation and processing. Untrusted bytes in, web-ready WebP renditions out.
 *
 * - The real content is identified from its signature (magic bytes); file names and browser MIME types are ignored.
 * - Only JPEG, PNG and WebP are decoded. Everything else (SVG, GIF, HEIC, PDF, scripts, ...) is refused before it
 *   reaches the decoder, so no other libvips loader is ever exercised by user input.
 * - Pixel/dimension limits are checked from the header before decoding (decompression bombs) and enforced again
 *   by the decoder (`limitInputPixels`).
 * - Output is ALWAYS re-encoded: EXIF orientation applied, metadata (EXIF/GPS/XMP/ICC) stripped, colour converted to
 *   sRGB. The original upload is never stored or served, so nothing the client sent is delivered back verbatim.
 */
import {
  MENU_IMAGE_ACCEPTED_TYPES,
  type MenuImageSourceType,
} from "@restaurant-platform/contracts";
import sharp, { type Metadata, type SharpOptions } from "sharp";
import { AppError } from "../../../shared/errors/app-error.js";

export type SourceImageType = MenuImageSourceType;
export const ACCEPTED_IMAGE_TYPES: readonly SourceImageType[] = MENU_IMAGE_ACCEPTED_TYPES;

export const IMAGE_LIMITS = {
  /** Longest side of the main rendition. */
  mainMaxSide: 1200,
  /** Longest side of the thumbnail rendition (menu lists, POS tiles). */
  thumbMaxSide: 320,
  /** Refuse sources larger than this on either side. */
  maxSourceSide: 10_000,
  /** Refuse sources with more pixels than this (about 40 MP). */
  maxSourcePixels: 40_000_000,
  /** Refuse sources this small on either side (unusable as a photo). */
  minSourceSide: 32,
  mainQuality: 82,
  thumbQuality: 76,
} as const;

export const imageErrors = {
  unsupported: () =>
    new AppError(415, "unsupported_image_type", "Only JPEG, PNG and WebP images are accepted"),
  invalid: () => new AppError(422, "invalid_image", "The file is not a readable image"),
  tooLarge: (maxBytes: number) =>
    new AppError(413, "image_too_large", "Image file is too large", { maxBytes }),
  dimensions: () =>
    new AppError(
      422,
      "image_dimensions_invalid",
      "Image dimensions are outside the allowed range",
      {
        maxSide: IMAGE_LIMITS.maxSourceSide,
        maxPixels: IMAGE_LIMITS.maxSourcePixels,
        minSide: IMAGE_LIMITS.minSourceSide,
      },
    ),
  empty: () => new AppError(400, "image_missing", "No image data was sent"),
  busy: () =>
    new AppError(503, "image_processing_busy", "Image processing is busy, please retry", {
      retryAfterSeconds: 5,
    }),
};

/** Identifies JPEG / PNG / WebP from the file signature. Returns null for anything else. */
export function detectImageType(buf: Uint8Array): SourceImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

const SHARP_FORMAT: Record<SourceImageType, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface Rendition {
  body: Buffer;
  width: number;
  height: number;
  byteSize: number;
  contentType: "image/webp";
}

export interface ProcessedImage {
  sourceType: SourceImageType;
  sourceByteSize: number;
  main: Rendition;
  thumb: Rendition;
}

/** Validates and re-encodes an uploaded photo. Throws AppError (415/413/422/400) for unacceptable input. */
export async function processMenuImage(
  input: Buffer,
  opts: { maxBytes: number },
): Promise<ProcessedImage> {
  if (input.length === 0) throw imageErrors.empty();
  if (input.length > opts.maxBytes) throw imageErrors.tooLarge(opts.maxBytes);
  const sourceType = detectImageType(input);
  if (!sourceType) throw imageErrors.unsupported();

  const decoderOptions: SharpOptions = {
    limitInputPixels: IMAGE_LIMITS.maxSourcePixels,
    failOn: "warning", // truncated/corrupt data is rejected, not silently padded
    pages: 1, // animated WebP/PNG: first frame only
    sequentialRead: true,
  };

  let meta: Metadata;
  try {
    meta = await sharp(input, { ...decoderOptions, limitInputPixels: false }).metadata();
  } catch {
    throw imageErrors.invalid();
  }
  // The decoder must agree with the signature (no polyglots slipping through to another loader).
  if (meta.format !== SHARP_FORMAT[sourceType]) throw imageErrors.invalid();
  const { width, height } = meta;
  if (!width || !height) throw imageErrors.invalid();
  if (
    width > IMAGE_LIMITS.maxSourceSide ||
    height > IMAGE_LIMITS.maxSourceSide ||
    width * height > IMAGE_LIMITS.maxSourcePixels ||
    width < IMAGE_LIMITS.minSourceSide ||
    height < IMAGE_LIMITS.minSourceSide
  )
    throw imageErrors.dimensions();

  try {
    const [main, thumb] = await Promise.all([
      render(input, decoderOptions, IMAGE_LIMITS.mainMaxSide, IMAGE_LIMITS.mainQuality),
      render(input, decoderOptions, IMAGE_LIMITS.thumbMaxSide, IMAGE_LIMITS.thumbQuality),
    ]);
    return { sourceType, sourceByteSize: input.length, main, thumb };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw imageErrors.invalid();
  }
}

async function render(
  input: Buffer,
  decoderOptions: SharpOptions,
  maxSide: number,
  quality: number,
): Promise<Rendition> {
  const { data, info } = await sharp(input, decoderOptions)
    .rotate() // apply EXIF orientation, then the orientation tag is dropped with the rest of the metadata
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .webp({ quality, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  return {
    body: data,
    width: info.width,
    height: info.height,
    byteSize: data.length,
    contentType: "image/webp",
  };
}

/**
 * Bounds concurrent image processing per process so uploads cannot starve ordering/checkout of CPU or memory.
 * Excess requests wait in a short queue; beyond that they get a retryable 503.
 */
export function createProcessingGate(opts: { concurrency: number; maxQueue: number }) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= opts.concurrency) {
      if (queue.length >= opts.maxQueue) throw imageErrors.busy();
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}
