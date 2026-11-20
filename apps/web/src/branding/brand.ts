import "server-only";
import type { PublicBrand } from "@restaurant-platform/contracts";
import { headers } from "next/headers";

/** Neutral placeholder used when a host has no configured brand. Never a developer brand. */
const NEUTRAL: PublicBrand = {
  displayName: "Restaurant",
  shortMark: "R",
  primaryColor: "#db020e",
  supportEmail: null,
  supportPhone: null,
};
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Resolves the white-label brand for the current request host (server-side, public fields only). */
export async function getBrand(): Promise<PublicBrand> {
  const host = (await headers()).get("host") ?? "";
  const api = process.env.WEB_INTERNAL_API_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${api}/api/v1/public/brand?host=${encodeURIComponent(host)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return NEUTRAL;
    const brand = (await res.json()) as PublicBrand;
    return HEX.test(brand.primaryColor) ? brand : { ...brand, primaryColor: NEUTRAL.primaryColor };
  } catch {
    return NEUTRAL;
  }
}
