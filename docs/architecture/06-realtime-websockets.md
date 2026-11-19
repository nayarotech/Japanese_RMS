# F. Real-time and WebSocket scaling

## Design in one sentence

PostgreSQL commits the truth, the **outbox** records what changed, the **worker** relays it through the
**Socket.IO Redis adapter** to authorized rooms on every API replica, and clients **reconcile** with the API
after any gap.

```mermaid
sequenceDiagram
  participant D1 as POS device A (api-1)
  participant API as api-1
  participant PG as PostgreSQL
  participant W as worker
  participant R as Redis
  participant API2 as api-2
  participant D2 as POS device B (api-2)

  D1->>API: POST order (HTTP)
  API->>PG: BEGIN; insert order + outbox(order.created); COMMIT
  API-->>D1: 201 order
  W->>PG: claim outbox rows (SKIP LOCKED)
  W->>R: emit to room t:{tenant}:l:{location} (redis emitter)
  R-->>API: fan-out
  R-->>API2: fan-out
  API2-->>D2: order.created {orderId, version}
  D2->>API2: (if gap/version jump) GET changes since cursor
```

## Connection lifecycle

1. **Handshake auth:** the Socket.IO middleware reads the same session cookie as HTTP (same origin). It
   validates the session in `identity` and builds an `AccessContext`. POS devices use their device session;
   QR customers use their scoped customer session. Unauthenticated connections are rejected.
2. **Origin check** against allowed brand hosts (WebSocket requests carry an `Origin` header). This prevents cross-site WebSocket hijacking.
3. **Room join is server-decided:** after auth, the server joins the socket to rooms the context allows.
   Clients may _request_ a location switch via an event, which is authorized like any request.
4. **Revocation:** on logout, session revoke, membership removal or support-grant expiry, the server
   publishes a `disconnect` command (via the Redis adapter `in(room).disconnectSockets()` pattern for that user/session).
5. **Re-validation:** long-lived sockets re-check session validity periodically (for example every 5 min) and on every client-originated event.

## Rooms

| Room                               | Members                             | Example events                                                                                           |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `t:{tenantId}`                     | Tenant admins                       | `entitlements.changed`, `settings.updated`                                                               |
| `t:{tenantId}:l:{locationId}`      | Staff and POS devices of a location | `order.created/updated/cancelled`, `table.status_changed`, `checkout.completed`, `online_order.received` |
| `t:{tenantId}:ts:{tableSessionId}` | QR customers at that table          | Their order status only                                                                                  |
| `p:ops`                            | Platform operators (optional)       | Operational alerts, never tenant business data                                                           |

Room names contain only ids. Payloads are **minimal** (`{type, entityId, version, occurredAt}` plus small
display data). Clients fetch details over HTTP with full authorization when needed, which limits what any
misrouting could disclose.

## Client-originated events

Treated exactly like HTTP requests: Zod-validated payload, `AccessContext` from the socket, permission check,
entitlement check, rate limit per socket, and executed through the same application use case. Mutations
over WebSocket are kept to a minimum. **HTTP is the primary write path** (idempotency keys, simpler retries).

## Reliability rules

- **Never emit before commit.** Events are produced only from committed outbox rows, never inline in a transaction.
- **Redis Pub/Sub is not durable.** If a device is disconnected or Redis drops a message, nothing is lost:
  - every entity carries a `version`, and every location has a monotonically increasing **change cursor** (outbox id);
  - on reconnect (and on any version gap), the client calls `GET /…/changes?since={cursor}` or refetches the view;
  - POS screens also refetch on focus or visibility change and on a slow periodic timer as a safety net.
- **At-least-once delivery:** clients deduplicate by `(entityId, version)`.
- **Outbox relay** uses `FOR UPDATE SKIP LOCKED` batches so multiple workers never double-claim, and records `processed_at`. Relaying is idempotent.

## Multi-instance specifics

- `@socket.io/redis-adapter` on every API replica, and `@socket.io/redis-emitter` in the worker (no socket server in the worker).
- **Transport and stickiness:** Socket.IO's HTTP long-polling fallback requires sticky sessions. Proposal: enable
  load-balancer cookie stickiness _and_ keep the polling fallback (some restaurant networks interfere with
  WebSockets). Alternative: WebSocket-only transport, no stickiness. **Open decision.**
- **Graceful shutdown:** on SIGTERM the replica stops accepting new sockets, tells connected clients to
  reconnect (they land on other replicas), waits up to the grace period, then exits. Clients reconnect with
  jittered exponential backoff and resync via the change cursor.
- **Capacity:** connections are mostly idle. Plan roughly 1–5 sockets per location (devices and admin tabs) plus
  transient QR customers. At 2,000 locations that is on the order of 10–20k sockets across replicas, which is
  modest for Node, but must be **confirmed by load testing** (k6 WebSocket scenarios).
