# Operations (planned)

Runbooks and operational records will live here. Nothing is operational yet.

| Planned document         | Content                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `local-development.md`   | Prerequisites, `.env` setup, starting Compose, running apps, resetting data                                       |
| `ci-cd.md`               | Pipeline stages, required checks, protected environments, image promotion                                         |
| `migrations.md`          | Expand/contract rules, running the migration task, failure handling                                               |
| `deploy-and-rollback.md` | Rolling deploy steps, health verification, rollback by image digest                                               |
| `backup-and-restore.md`  | PITR settings, logical backups, quarterly restore drill procedure and results log                                 |
| `incident-response.md`   | Severity levels, on-call, containment steps, partner communication, APPI notification check, post-mortem template |
| `load-test-results.md`   | k6 scenarios, environment, results, resulting replica and pool sizing                                             |
| `access-management.md`   | Who has which production access, MFA, break-glass procedure, quarterly access review                              |

## CI/CD roadmap

| Stage                                                                   | Phase 0 status                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| Format, lint, typecheck, test                                           | **Created** in `.github/workflows/ci.yml`                    |
| Brand-leak check                                                        | **Created** (needs the `BRAND_DENYLIST` repository variable) |
| Dependency audit, secret scan                                           | **Created** (`pnpm audit`, gitleaks)                         |
| Dependabot                                                              | **Created** (`.github/dependabot.yml`)                       |
| Integration + cross-tenant tests with PG/Redis services                 | Planned (Phase 1)                                            |
| Image build, Trivy scan, SBOM                                           | Planned (Phase 1, once images can build)                     |
| CodeQL                                                                  | Planned                                                      |
| Staging/production deploy with OIDC + manual approval + migrations task | Planned (after hosting decision)                             |
