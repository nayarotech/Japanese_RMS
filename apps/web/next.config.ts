import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Local development: share the monorepo root .env (deployed environments inject real env vars).
try {
  process.loadEnvFile("../../.env");
} catch {
  /* not present in CI/production */
}

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const apiOrigin = process.env["WEB_INTERNAL_API_URL"] ?? "http://localhost:4000";

const config: NextConfig = {
  output: "standalone",
  // Monorepo: trace files from the repository root so the standalone server includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  // Do not let the framework write files into the repository at dev time.
  agentRules: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_SOCKET_URL: process.env.NEXT_PUBLIC_SOCKET_URL ?? "" },
  // Same-origin contract: the browser calls /api/* on the web origin; Next forwards to the private API.
  // In production the load balancer performs this routing (docs/architecture/01-high-level.md).
  rewrites() {
    return Promise.resolve([{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }]);
  },
  headers() {
    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]);
  },
};

export default withNextIntl(config);
