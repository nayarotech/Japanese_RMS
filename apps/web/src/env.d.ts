declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_SOCKET_URL?: string;
    readonly NEXT_PUBLIC_MAP_TILE_URL?: string;
    readonly NEXT_PUBLIC_MAP_ATTRIBUTION?: string;
    readonly WEB_INTERNAL_API_URL?: string;
  }
}
