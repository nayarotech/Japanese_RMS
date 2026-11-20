import { getBrand } from "../../branding/brand";

/** Favicon generated from the active brand (mark + color): no static, brand-specific favicon in the build. */
export async function GET(): Promise<Response> {
  const brand = await getBrand();
  const mark = brand.shortMark.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "R";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="${brand.primaryColor}"/><text x="24" y="32" font-family="Inter,Arial,sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${mark}</text></svg>`;
  return new Response(svg, {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=300" },
  });
}
