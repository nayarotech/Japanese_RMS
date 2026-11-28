import type { PublicTableResponse } from "@restaurant-platform/contracts";

/** Public menu shape shared by the table-QR menu and the online storefront (same server read model). */
export type CustomerCategory = PublicTableResponse["menu"][number];
export type CustomerMenuItem = CustomerCategory["items"][number];
