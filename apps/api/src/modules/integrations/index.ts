/** integrations: third-party services behind ports. Only geocoding exists so far (online-orders delivery area). */
export {
  type GeocodePrecision,
  type GeocodeQuery,
  type GeocodeResult,
  type Geocoder,
  GeocodingUnavailableError,
  STATIC_DEMO_POSTAL_CODES,
  STATIC_DEMO_STORE,
  createGeocoder,
  createStaticDemoGeocoder,
  disabledGeocoder,
  withTimeout,
} from "./geocoding.js";
