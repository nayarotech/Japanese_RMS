"use client";
/**
 * Delivery-area map (Leaflet): shows the store pin and one circle per distance tier. Clicking the map or dragging the
 * pin sets the store location; the latitude/longitude inputs beside it stay the keyboard-accessible way to do the same.
 *
 * Leaflet touches `window` at import time, so it is loaded inside an effect (never during server rendering). Tiles come
 * from NEXT_PUBLIC_MAP_TILE_URL (OpenStreetMap by default; use your own tile provider for production traffic).
 */
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import type { FeeTierDto } from "@restaurant-platform/contracts";
import { useEffect, useRef, useState } from "react";

type LatLng = { latitude: number; longitude: number };

const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
/** Shown until a store location is set: Tokyo Station. */
const DEFAULT_CENTER: [number, number] = [35.6812, 139.7671];
const DEFAULT_ZOOM = 12;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function DeliveryAreaMap({
  location,
  tiers,
  onChange,
  label,
  className = "",
}: {
  location: LatLng | null;
  tiers: FeeTierDto[];
  onChange: (next: LatLng) => void;
  label: string;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const marker = useRef<Leaflet.Marker | null>(null);
  const rings = useRef<Leaflet.LayerGroup | null>(null);
  const lastFit = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [L, setL] = useState<typeof Leaflet | null>(null);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let instance: Leaflet.Map | null = null;
    void import("leaflet").then((mod) => {
      const lib = (mod as { default?: typeof Leaflet }).default ?? mod;
      if (cancelled || !el.current) return;
      instance = lib
        .map(el.current, { scrollWheelZoom: false })
        .setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      lib.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(instance);
      rings.current = lib.layerGroup().addTo(instance);
      instance.on("click", (e: Leaflet.LeafletMouseEvent) =>
        onChangeRef.current({ latitude: round6(e.latlng.lat), longitude: round6(e.latlng.lng) }),
      );
      // Scroll-zoom only once the map has been focused, so the settings page still scrolls normally.
      instance.on("focus", () => instance?.scrollWheelZoom.enable());
      instance.on("blur", () => instance?.scrollWheelZoom.disable());
      map.current = instance;
      setL(lib);
    });
    return () => {
      cancelled = true;
      instance?.remove();
      map.current = null;
      marker.current = null;
      rings.current = null;
      lastFit.current = null;
    };
  }, []);

  // Store pin.
  useEffect(() => {
    const m = map.current;
    if (!L || !m) return;
    if (!location) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const pos: [number, number] = [location.latitude, location.longitude];
    if (!marker.current) {
      const icon = L.divIcon({
        className: "",
        html: '<span class="block size-4 rounded-full bg-ink ring-4 ring-white shadow-md"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      marker.current = L.marker(pos, { icon, draggable: true, keyboard: false }).addTo(m);
      marker.current.on("dragend", () => {
        const p = marker.current?.getLatLng();
        if (p) onChangeRef.current({ latitude: round6(p.lat), longitude: round6(p.lng) });
      });
    } else {
      marker.current.setLatLng(pos);
    }
  }, [L, location]);

  // Tier circles; re-frame the map when the outer radius changes or the pin is first placed.
  useEffect(() => {
    const m = map.current;
    const group = rings.current;
    if (!L || !m || !group) return;
    group.clearLayers();
    if (!location) return;
    const center: [number, number] = [location.latitude, location.longitude];
    const brand = cssColor("--color-brand", "#db020e");
    const brandDark = cssColor("--color-brand-dark", "#b0010b");
    const sorted = [...tiers].sort((a, b) => b.maxDistanceM - a.maxDistanceM);
    sorted.forEach((tier, i) => {
      L.circle(center, {
        radius: tier.maxDistanceM,
        color: i === 0 ? brand : brandDark,
        weight: 2,
        dashArray: i === 0 ? undefined : "6 6",
        fillColor: brand,
        fillOpacity: i === 0 ? 0.12 : 0,
        interactive: false,
      }).addTo(group);
    });
    const outer = sorted[0]?.maxDistanceM ?? 0;
    const fitKey = String(outer);
    if (lastFit.current !== fitKey) {
      lastFit.current = fitKey;
      if (outer > 0) m.fitBounds(L.latLng(center).toBounds(outer * 2), { padding: [16, 16] });
      else m.setView(center, 15);
    } else if (!m.getBounds().contains(center)) {
      m.panTo(center);
    }
  }, [L, location, tiers]);

  return (
    <div
      ref={el}
      role="application"
      aria-label={label}
      // `isolate` keeps Leaflet's high z-index panes below the sticky save bar.
      className={`isolate overflow-hidden rounded-[12px] border border-line bg-chip ${className}`}
    />
  );
}
