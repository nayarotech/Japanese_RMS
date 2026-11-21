/**
 * Address geocoding port (used by online-orders for server-side delivery-area checks).
 *
 * NO PAID PROVIDER IS SELECTED. Candidates (Google Geocoding, Mapbox, Yahoo! JAPAN YOLP, ZENRIN, GSI) differ in
 * Japanese address accuracy, terms of use (some forbid storing results or using them without their map) and price.
 * The choice and its API key belong to the business owner (docs/architecture/15-online-ordering.md).
 *
 * Contract:
 *  - `geocode` resolves a Japanese address to coordinates, or `null` when the address cannot be found.
 *  - Provider failures (timeout, quota, outage) THROW `GeocodingUnavailableError`; callers fail closed.
 *  - Never called inside a database transaction (network I/O while holding locks).
 *  - Coordinates sent by browsers are never used.
 */
export interface GeocodeQuery {
  postalCode: string; // 7 digits
  prefecture: string;
  city: string;
  line1: string;
  line2?: string | null;
}

/** How precisely the coordinates locate the address (coarse results are not accepted for delivery). */
export type GeocodePrecision = "rooftop" | "street" | "postal_code" | "city" | "prefecture";

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  precision: GeocodePrecision;
}

export interface Geocoder {
  /** Stable identifier for logs/snapshots ("disabled", "static_demo", provider name). */
  readonly name: string;
  /** False when no provider is configured: delivery cannot be verified and must be refused. */
  readonly enabled: boolean;
  geocode(query: GeocodeQuery): Promise<GeocodeResult | null>;
}

export class GeocodingUnavailableError extends Error {
  override name = "GeocodingUnavailableError";
}

/** Production default until a provider is integrated: delivery is unavailable, pickup keeps working. */
export const disabledGeocoder: Geocoder = {
  name: "disabled",
  enabled: false,
  geocode: () => Promise.reject(new GeocodingUnavailableError("No geocoding provider configured")),
};

/**
 * DEMO DATA FOR LOCAL DEVELOPMENT AND TESTS ONLY. Approximate centroids of a few Tokyo postal codes around the demo
 * store (35.6595, 139.7004). Refused by the config loader in staging/production.
 */
export const STATIC_DEMO_POSTAL_CODES: Readonly<Record<string, readonly [number, number]>> = {
  "1500002": [35.659, 139.706], // ~0.5 km
  "1500001": [35.67, 139.708], // ~1.3 km
  "1510053": [35.683, 139.699], // ~2.6 km
  "1600022": [35.6905, 139.706], // ~3.5 km
  "1000005": [35.6812, 139.7671], // ~6.5 km (outside the demo delivery area)
};
export const STATIC_DEMO_STORE = { latitude: 35.6595, longitude: 139.7004 } as const;

export function createStaticDemoGeocoder(
  table: Readonly<Record<string, readonly [number, number]>> = STATIC_DEMO_POSTAL_CODES,
): Geocoder {
  return {
    name: "static_demo",
    enabled: true,
    geocode: (q) => {
      const hit = table[q.postalCode];
      return Promise.resolve(
        hit ? { latitude: hit[0], longitude: hit[1], precision: "postal_code" } : null,
      );
    },
  };
}

/** Bounds a provider call; a slow provider counts as unavailable (fail closed), never as "not found". */
export function withTimeout(geocoder: Geocoder, timeoutMs: number): Geocoder {
  return {
    name: geocoder.name,
    enabled: geocoder.enabled,
    geocode: (q) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new GeocodingUnavailableError("Geocoding timed out"));
        }, timeoutMs);
        geocoder.geocode(q).then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(
              err instanceof GeocodingUnavailableError
                ? err
                : new GeocodingUnavailableError("Geocoding failed"),
            );
          },
        );
      }),
  };
}

export function createGeocoder(config: {
  GEOCODER_PROVIDER: "disabled" | "static_demo";
  GEOCODER_TIMEOUT_MS: number;
}): Geocoder {
  switch (config.GEOCODER_PROVIDER) {
    case "disabled":
      return disabledGeocoder;
    case "static_demo":
      return withTimeout(createStaticDemoGeocoder(), config.GEOCODER_TIMEOUT_MS);
  }
}
