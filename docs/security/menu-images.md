# Menu photo uploads: security notes

Design reference: [../architecture/16-menu-item-images.md](../architecture/16-menu-item-images.md).

## Trust boundaries

| Input                    | Trusted? | Handling                                                                                      |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------- |
| Uploaded bytes           | No       | Signature sniffed, decoded by an allow-listed loader only, re-encoded; original never stored. |
| `Content-Type` header    | No       | Only gates the body parser. Content decides the type.                                         |
| File name / storage path | n/a      | Not accepted at all. Keys are server-generated (128-bit random) under the caller's tenant.    |
| Menu item id (URL)       | No       | Must belong to the caller's location (RLS + `location_id` filter); otherwise 404.             |
| Public media key (URL)   | No       | Strict pattern; tenant taken from the key only to set RLS context; must match an active row.  |

## Controls

- **AuthZ:** `menu.manage` (owner, manager) checked in the backend before the body is read; CSRF token and Origin
  check on PUT/DELETE (shared staff middleware). Cashier, waiter and kitchen roles get 403.
- **Tenant isolation:** RLS on `menu_item_images`; CHECK constraint binds keys to the row's tenant prefix; cross-tenant
  item ids return 404 without revealing existence; the media route resolves keys inside the key's tenant context, so
  swapping the tenant segment never finds another tenant's object.
- **Untrusted content:** JPEG/PNG/WebP only by signature; SVG (script), GIF, HEIC, TIFF, PDF refused before decoding;
  strict decode (`failOn: warning`); pixel and side limits from the header (decompression bombs) plus
  `limitInputPixels`; metadata (EXIF/GPS) stripped, so photos do not leak location data. Images are never executed or
  interpreted as code; responses carry `X-Content-Type-Options: nosniff` and a sandboxing CSP.
- **Resource limits:** 5 MB body limit (6 MB at the proxy, on this route only); 2 concurrent re-encodes per process with
  a short queue (then 503); 30 uploads per staff session per 10 minutes; public media reads 1,200/min per IP.
- **Credentials:** bucket credentials stay in the API process (prefer role-based credentials). Browsers receive only
  plain delivery URLs, never signed URLs, bucket names or keys of other tenants.
- **Audit:** `menu.item.image_added`, `menu.item.image_replaced`, `menu.item.image_removed` with the actor.

## Known limitations

- Photos of inactive menu items remain fetchable by anyone who already has their unguessable URL (staff saw it in the
  admin menu). Removing the photo makes the URL 404 immediately for uncached clients.
- Cached copies (browser/CDN, immutable for a year) may outlive a removal. Menu photos are not considered sensitive.
- Cross-tenant cleanup of abandoned uploads currently runs per tenant on the next photo change; a scheduled platform
  sweep is still to be added (see the architecture doc).
