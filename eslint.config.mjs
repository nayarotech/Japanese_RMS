// Root ESLint flat config for the whole monorepo.
// Formatting is owned by Prettier; ESLint is for correctness and architecture rules.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/coverage/**",
    "**/*.config.mjs",
  ]),

  js.configs.recommended,

  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": "error", // use the structured logger
    },
  },

  // React: `onClick={() => setState(x)}` shorthand is idiomatic.
  {
    files: ["**/*.tsx"],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
    },
  },

  // Node scripts (plain JS).
  {
    files: ["**/scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },

  // Tests: HTTP response bodies are untyped JSON; assertions validate them at runtime.
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },

  // Architecture guard: the domain layer must not depend on frameworks or infrastructure.
  // See docs/architecture/02-module-boundaries.md.
  {
    files: ["apps/api/src/modules/*/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "express",
                "pg",
                "kysely",
                "ioredis",
                "redis",
                "socket.io",
                "pino",
                "**/infrastructure/**",
                "**/http/**",
              ],
              message:
                "Domain code must stay framework- and infrastructure-free (docs/architecture/02-module-boundaries.md).",
            },
          ],
        },
      ],
    },
  },

  // Architecture guard: the frontend must never import backend source.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@restaurant-platform/api", "@restaurant-platform/api/*", "**/apps/api/**"],
              message:
                "The web app talks to the API over HTTP/WebSocket only. Share types via @restaurant-platform/contracts.",
            },
          ],
        },
      ],
    },
  },
]);
