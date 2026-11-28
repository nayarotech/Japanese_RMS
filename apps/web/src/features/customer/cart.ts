"use client";
/**
 * Customer cart shared by table-QR and online ordering. Each line is one dish with ITS OWN note, so two ramen with
 * different requests stay separate lines. Prices are never stored: every line is resolved against the menu the server
 * just returned, so the cart always shows current prices and availability. The server re-prices on submission.
 *
 * Persistence is per ordering context (`storageKey`: a table QR token or a store link token), so a cart built for one
 * restaurant or table can never be submitted to another. Stored data is untrusted and validated on load.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CustomerMenuItem } from "./types";

export const NOTE_MAX = 140;
export const QTY_MAX = 99;
export const LINES_MAX = 50;

export interface CartLine {
  key: string;
  itemId: string;
  quantity: number;
  note: string;
  /** Name when added: shown if the dish has since disappeared from the menu. */
  name: { ja: string; en: string | null };
}

export interface ResolvedLine extends CartLine {
  item: CustomerMenuItem | null;
  /** "removed": no longer on the menu; "unavailable": sold out now. */
  problem: "removed" | "unavailable" | null;
}

/** Code-point length (what the server limits), so Japanese and emoji count as one character each. */
export const noteLength = (s: string) => Array.from(s).length;
const clampNote = (s: string) => Array.from(s).slice(0, NOTE_MAX).join("");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isStoredLine(v: unknown): v is CartLine {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  const name = l["name"] as Record<string, unknown> | null | undefined;
  return (
    typeof l["key"] === "string" &&
    typeof l["itemId"] === "string" &&
    UUID.test(l["itemId"]) &&
    Number.isInteger(l["quantity"]) &&
    (l["quantity"] as number) >= 1 &&
    (l["quantity"] as number) <= QTY_MAX &&
    typeof l["note"] === "string" &&
    typeof name === "object" &&
    name !== null &&
    typeof name["ja"] === "string"
  );
}

function parseStored(raw: string | null): CartLine[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as { savedAt?: unknown; lines?: unknown };
    if (typeof data.savedAt !== "number" || Date.now() - data.savedAt > 12 * 3600_000) return [];
    if (!Array.isArray(data.lines)) return [];
    return data.lines
      .filter(isStoredLine)
      .slice(0, LINES_MAX)
      .map((l) => ({
        key: l.key.slice(0, 64),
        itemId: l.itemId,
        quantity: l.quantity,
        note: clampNote(l.note),
        name: {
          ja: l.name.ja.slice(0, 80),
          en: typeof l.name.en === "string" ? l.name.en.slice(0, 80) : null,
        },
      }));
  } catch {
    return [];
  }
}

function storage(kind: "session" | "local"): Storage | null {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null; // private mode / disabled storage: the cart still works in memory
  }
}

export function useCart(
  storageKey: string | null,
  menu: ReadonlyMap<string, CustomerMenuItem> | null,
  persist: "session" | "local",
) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!storageKey || loadedFor.current === storageKey) return;
    loadedFor.current = storageKey;
    setLines(parseStored(storage(persist)?.getItem(storageKey) ?? null));
  }, [storageKey, persist]);

  useEffect(() => {
    if (!storageKey || loadedFor.current !== storageKey) return;
    const s = storage(persist);
    if (!s) return;
    try {
      if (lines.length === 0) s.removeItem(storageKey);
      else s.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), lines }));
    } catch {
      /* quota: keep in memory */
    }
  }, [lines, storageKey, persist]);

  /** Adds a dish. Lines merge only when the dish AND the request text are the same. */
  const add = useCallback((item: CustomerMenuItem, quantity: number, note: string) => {
    const n = clampNote(note.trim());
    setLines((cur) => {
      const same = cur.find((l) => l.itemId === item.id && l.note.trim() === n);
      if (same)
        return cur.map((l) =>
          l === same ? { ...l, quantity: Math.min(QTY_MAX, l.quantity + quantity) } : l,
        );
      if (cur.length >= LINES_MAX) return cur;
      return [
        ...cur,
        { key: crypto.randomUUID(), itemId: item.id, quantity, note: n, name: item.name },
      ];
    });
  }, []);

  const setQuantity = useCallback((key: string, quantity: number) => {
    setLines((cur) =>
      cur
        .map((l) => (l.key === key ? { ...l, quantity: Math.min(QTY_MAX, quantity) } : l))
        .filter((l) => l.quantity > 0),
    );
  }, []);
  const setNote = useCallback((key: string, note: string) => {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, note: clampNote(note) } : l)));
  }, []);
  const remove = useCallback((key: string) => {
    setLines((cur) => cur.filter((l) => l.key !== key));
  }, []);
  /** Moves one portion to its own line, so it can carry a different request. */
  const split = useCallback((key: string) => {
    setLines((cur) =>
      cur.length >= LINES_MAX
        ? cur
        : cur.flatMap((l) =>
            l.key === key && l.quantity > 1
              ? [
                  { ...l, quantity: l.quantity - 1 },
                  { ...l, key: crypto.randomUUID(), quantity: 1, note: "" },
                ]
              : [l],
          ),
    );
  }, []);
  const clear = useCallback(() => {
    setLines([]);
  }, []);
  const removeProblems = useCallback(() => {
    setLines((cur) => cur.filter((l) => menu?.get(l.itemId)?.isAvailable === true));
  }, [menu]);

  const resolved: ResolvedLine[] = useMemo(
    () =>
      lines.map((l) => {
        const item = menu?.get(l.itemId) ?? null;
        return {
          ...l,
          item,
          problem: !menu ? null : !item ? "removed" : item.isAvailable ? null : "unavailable",
        };
      }),
    [lines, menu],
  );
  const valid = resolved.filter((l) => l.item && !l.problem);
  const count = valid.reduce((s, l) => s + l.quantity, 0);
  const subtotal = valid.reduce((s, l) => s + (l.item?.priceYen ?? 0) * l.quantity, 0);
  const problems = resolved.filter((l) => l.problem !== null);
  /** Items as the API expects them (only orderable lines). */
  const orderLines = valid.map((l) => ({
    menuItemId: l.itemId,
    quantity: l.quantity,
    note: l.note.trim() || null,
  }));
  const quantityOf = useCallback(
    (itemId: string) => lines.reduce((s, l) => (l.itemId === itemId ? s + l.quantity : s), 0),
    [lines],
  );

  return {
    lines: resolved,
    count,
    subtotal,
    problems,
    orderLines,
    quantityOf,
    add,
    setQuantity,
    setNote,
    remove,
    split,
    clear,
    removeProblems,
  };
}

export type Cart = ReturnType<typeof useCart>;
