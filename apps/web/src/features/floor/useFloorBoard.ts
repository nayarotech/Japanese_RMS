"use client";
/**
 * Floor board state. PostgreSQL (GET /floor/board) is the only source of truth: socket events are hints that trigger
 * a coalesced refetch, reconnects reconcile, and a slow poll runs ONLY while the socket is down. Actions never
 * update local state optimistically: the server decides (409 when another waiter got there first), then we reload.
 */
import type { FloorBoardResponse, RealtimeEvent } from "@restaurant-platform/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, staffApi } from "../../lib/api";
import { useRealtime } from "../../lib/realtime";

const EVENTS: readonly RealtimeEvent[] = [
  "waiter.food.ready",
  "waiter.food.picked_up",
  "waiter.food.served",
  "kitchen.item.status_changed",
  "order.created",
  "order.updated",
  "table.session.opened",
  "table.session.updated",
  "table.session.closed",
  "checkout.completed",
];

export interface ReadyAlert {
  id: string;
  tableName: string;
  items: { nameJa: string; nameEn: string | null; quantity: number }[];
}

export function useFloorBoard(onReadyAlert: (alert: ReadyAlert) => void) {
  const [board, setBoard] = useState<FloorBoardResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [skewMs, setSkewMs] = useState(0);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alertRef = useRef(onReadyAlert);
  alertRef.current = onReadyAlert;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const b = await staffApi.get<FloorBoardResponse>("/floor/board");
      if (mine !== seq.current) return; // a newer request is in flight: ignore this stale answer
      setBoard(b);
      setSkewMs(new Date(b.serverTime).getTime() - Date.now());
      setLoadError(null);
    } catch (err) {
      if (mine === seq.current) setLoadError(err);
    }
  }, []);

  /** Several events usually arrive together (status change + ready + served): refetch once. */
  const scheduleLoad = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 150);
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const { connected } = useRealtime(EVENTS, (event, payload) => {
    if (event === "waiter.food.ready" && typeof payload["tableName"] === "string") {
      const items = Array.isArray(payload["items"])
        ? (payload["items"] as ReadyAlert["items"]).slice(0, 6)
        : [];
      alertRef.current({
        id: typeof payload["eventId"] === "string" ? payload["eventId"] : crypto.randomUUID(),
        tableName: payload["tableName"],
        items,
      });
    }
    scheduleLoad();
  });

  /** Runs a waiter action, then always reconciles from the server (also after a rejection). */
  const act = useCallback(
    async (path: string, kitchenItemIds: string[]): Promise<ApiError | null> => {
      try {
        await staffApi.send("POST", path, { kitchenItemIds });
        return null;
      } catch (err) {
        return err instanceof ApiError ? err : new ApiError(0, "network_error", "Network error");
      } finally {
        await load();
      }
    },
    [load],
  );

  return {
    board,
    loadError,
    connected,
    reload: load,
    /** Current time on the server's clock (so "waiting 4 min" is right even if this device's clock is off). */
    now: () => Date.now() + skewMs,
    pickUp: (ids: string[]) => act("/floor/items/pickup", ids),
    serve: (ids: string[]) => act("/floor/items/serve", ids),
  };
}
