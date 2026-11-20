declare namespace NodeJS {
  interface ProcessEnv {
    readonly NEXT_PUBLIC_SOCKET_URL?: string;
    readonly WEB_INTERNAL_API_URL?: string;
  }
}
