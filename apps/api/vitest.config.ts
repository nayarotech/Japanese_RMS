import { defineConfig } from "vitest/config";

// Load local env (CI sets these variables directly). Tests always use a dedicated database.
try {
  process.loadEnvFile("../../.env");
} catch {
  /* CI provides env vars */
}

export default defineConfig({
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Integration files share one database and Redis; run files sequentially for deterministic outbox/socket assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      APP_ENV: "test",
      POSTGRES_DB: `${process.env["POSTGRES_DB"] ?? "restaurant_platform"}_test`,
      LOG_LEVEL: "silent",
      LOG_PRETTY: "false",
      COOKIE_SECURE: "false",
      APP_PUBLIC_ORIGINS: "http://localhost:3000",
    },
  },
});
