/** Menu photo validation and re-encoding (no database or storage involved). */
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AppError } from "../../../shared/errors/app-error.js";
import {
  IMAGE_LIMITS,
  createProcessingGate,
  detectImageType,
  processMenuImage,
} from "./processing.js";

const MAX = 5 * 1024 * 1024;

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 90, b: 40 } } });
}
function noisy(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  });
}

/** A syntactically valid PNG whose header claims the given size (the pixel data is tiny). */
function pngHeaderClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function rejects(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  expect((err as AppError).code).toBe(code);
}

describe("detectImageType (content signature, not name or MIME type)", () => {
  it("recognises JPEG, PNG and WebP", async () => {
    expect(detectImageType(await solid(40, 40).jpeg().toBuffer())).toBe("image/jpeg");
    expect(detectImageType(await solid(40, 40).png().toBuffer())).toBe("image/png");
    expect(detectImageType(await solid(40, 40).webp().toBuffer())).toBe("image/webp");
  });
  it("returns null for other formats and junk", async () => {
    expect(detectImageType(await solid(40, 40).gif().toBuffer())).toBeNull();
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(Buffer.from("%PDF-1.7\n"))).toBeNull();
    expect(detectImageType(Buffer.from("RIFF0000WAVEfmt "))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("processMenuImage", () => {
  it("accepts JPEG and re-encodes to WebP main + thumbnail", async () => {
    const out = await processMenuImage(await solid(1600, 1200).jpeg().toBuffer(), {
      maxBytes: MAX,
    });
    expect(out.sourceType).toBe("image/jpeg");
    expect([out.main.width, out.main.height]).toEqual([1200, 900]);
    expect([out.thumb.width, out.thumb.height]).toEqual([320, 240]);
    expect(detectImageType(out.main.body)).toBe("image/webp");
    expect(detectImageType(out.thumb.body)).toBe("image/webp");
  });

  it("accepts PNG (alpha kept) and WebP", async () => {
    const png = await sharp({
      create: { width: 500, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const a = await processMenuImage(png, { maxBytes: MAX });
    expect(a.sourceType).toBe("image/png");
    expect([a.main.width, a.main.height]).toEqual([500, 400]); // never enlarged
    expect((await sharp(a.main.body).metadata()).hasAlpha).toBe(true);

    const b = await processMenuImage(await solid(3000, 1000).webp().toBuffer(), { maxBytes: MAX });
    expect(b.sourceType).toBe("image/webp");
    expect([b.main.width, b.main.height]).toEqual([1200, 400]); // aspect ratio preserved
    expect([b.thumb.width, b.thumb.height]).toEqual([320, 107]);
  });

  it("applies EXIF orientation and strips all metadata (EXIF, GPS, ICC)", async () => {
    // Stored landscape 1800x1200 with "rotate 90° CW" orientation: displayed portrait.
    const jpeg = await solid(1800, 1200)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: "private-owner", Artist: "someone" } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const out = await processMenuImage(jpeg, { maxBytes: MAX });
    expect([out.main.width, out.main.height]).toEqual([800, 1200]);
    const meta = await sharp(out.main.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(out.main.body.includes(Buffer.from("private-owner"))).toBe(false);
  });

  it("optimises: output is much smaller than a large source and within the size limits", async () => {
    const src = await noisy(1800, 1400).jpeg({ quality: 92 }).toBuffer();
    expect(src.length).toBeGreaterThan(1_000_000);
    expect(src.length).toBeLessThan(MAX);
    const out = await processMenuImage(src, { maxBytes: MAX });
    expect(Math.max(out.main.width, out.main.height)).toBeLessThanOrEqual(IMAGE_LIMITS.mainMaxSide);
    expect(Math.max(out.thumb.width, out.thumb.height)).toBeLessThanOrEqual(
      IMAGE_LIMITS.thumbMaxSide,
    );
    expect(out.main.byteSize).toBeLessThan(src.length / 2);
    expect(out.thumb.byteSize).toBeLessThan(out.main.byteSize / 4);
  });

  it("rejects unsupported formats by content (415)", async () => {
    await rejects(
      processMenuImage(await solid(40, 40).gif().toBuffer(), { maxBytes: MAX }),
      415,
      "unsupported_image_type",
    );
    await rejects(
      processMenuImage(Buffer.from("<svg onload=alert(1)></svg>"), { maxBytes: MAX }),
      415,
      "unsupported_image_type",
    );
    await rejects(
      processMenuImage(await solid(40, 40).tiff().toBuffer(), { maxBytes: MAX }),
      415,
      "unsupported_image_type",
    );
  });

  it("rejects malformed content that carries a valid signature (422)", async () => {
    const pngJunk = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not really a png"),
    ]);
    await rejects(processMenuImage(pngJunk, { maxBytes: MAX }), 422, "invalid_image");
    const jpeg = await noisy(800, 600).jpeg().toBuffer();
    await rejects(
      processMenuImage(jpeg.subarray(0, Math.floor(jpeg.length / 2)), { maxBytes: MAX }),
      422,
      "invalid_image",
    );
  });

  it("rejects decompression bombs and absurd dimensions from the header, before decoding", async () => {
    await rejects(
      processMenuImage(pngHeaderClaiming(60_000, 60_000), { maxBytes: MAX }),
      422,
      "image_dimensions_invalid",
    );
    // Under the per-side limit but over the pixel budget (7000 x 7000 = 49 MP).
    await rejects(
      processMenuImage(pngHeaderClaiming(7000, 7000), { maxBytes: MAX }),
      422,
      "image_dimensions_invalid",
    );
    await rejects(
      processMenuImage(await solid(10, 10).png().toBuffer(), { maxBytes: MAX }),
      422,
      "image_dimensions_invalid",
    );
  });

  it("rejects oversized and empty input", async () => {
    await rejects(
      processMenuImage(Buffer.alloc(MAX + 1, 0xff), { maxBytes: MAX }),
      413,
      "image_too_large",
    );
    await rejects(processMenuImage(Buffer.alloc(0), { maxBytes: MAX }), 400, "image_missing");
  });
});

describe("createProcessingGate", () => {
  it("bounds concurrency and sheds load beyond the queue", async () => {
    const run = createProcessingGate({ concurrency: 2, maxQueue: 1 });
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
      });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const p = [task(), task(), task()]; // 2 running, 1 queued
    await tick();
    expect(releases).toHaveLength(2);
    await expect(task()).rejects.toMatchObject({ status: 503, code: "image_processing_busy" });
    releases.shift()?.(); // finishing one lets the queued task start
    await tick();
    expect(releases).toHaveLength(2);
    releases.splice(0).forEach((r) => r());
    await Promise.all(p);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
});
