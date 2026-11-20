"use client";
/**
 * Socket.IO client hook. The socket is a NOTIFICATION channel: on any relevant event (and on every
 * (re)connect) the screen refetches authoritative state from the API, so a missed event can never
 * leave a device permanently stale.
 */
import type { RealtimeEvent } from "@restaurant-platform/contracts";
import { useEffect, useRef, useState } from "react";
import { type Socket, io } from "socket.io-client";

let shared: Socket | null = null;
let users = 0;

function getSocket(): Socket {
  if (!shared) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL ?? "";
    shared = io(url || undefined, {
      path: "/socket.io",
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
  }
  return shared;
}

export function useRealtime(
  events: readonly RealtimeEvent[],
  onChange: (event: RealtimeEvent, payload: Record<string, unknown>) => void,
  enabled = true,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onChange);
  handler.current = onChange;
  const key = events.join(",");

  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    users += 1;
    const onConnect = () => {
      setConnected(true);
      handler.current("order.updated", { reconnect: true }); // reconcile after (re)connect
    };
    const onDisconnect = () => {
      setConnected(false);
    };
    const listeners = key.split(",").map((e) => {
      const fn = (payload: Record<string, unknown>) => {
        handler.current(e as RealtimeEvent, payload);
      };
      socket.on(e, fn);
      return [e, fn] as const;
    });
    socket.on("session.ready", onConnect);
    socket.on("disconnect", onDisconnect);
    if (socket.connected) setConnected(true);
    // Safety net: periodic refetch in case the socket is blocked by the network.
    const poll = setInterval(() => {
      if (!socket.connected) handler.current("order.updated", { poll: true });
    }, 15_000);
    return () => {
      clearInterval(poll);
      for (const [e, fn] of listeners) socket.off(e, fn);
      socket.off("session.ready", onConnect);
      socket.off("disconnect", onDisconnect);
      users -= 1;
      if (users === 0) {
        socket.disconnect();
        shared = null;
      }
    };
  }, [key, enabled]);

  return { connected };
}
