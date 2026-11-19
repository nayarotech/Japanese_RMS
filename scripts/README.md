# scripts/

Repository-level developer and CI scripts. Scripts here must be:

- non-interactive (CI-safe), POSIX `sh` or TypeScript run via the workspace toolchain;
- safe by default (no destructive action without an explicit flag);
- free of secrets (read them from the environment).

| Script                | Status  | Purpose                                                                                                        |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `check-brand-leak.sh` | Created | White-label guard. Fails if a denylisted brand term (from `BRAND_DENYLIST`) appears in `apps/` or `packages/`. |

Planned (not created yet):

- `db-migrate`: run migrations with the migrator credential (Phase 1).
- `db-seed-dev`: local-only seed data. Must refuse to run when `APP_ENV` is `staging` or `production`.
- `new-module`: optional generator for the standard module layout, added only if the team wants one.
