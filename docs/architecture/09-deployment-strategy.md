# J. Deployment strategy

Nothing is deployed in Phase 0. This is the intended structure.

## Environments

| Environment   | Purpose                                              | Infrastructure                                                                                              | Data                                                             | Access                                      |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `development` | Local coding                                         | Docker Compose (`infra/compose`): PG + Redis containers, apps on host or in containers                      | Synthetic seed data only                                         | Developer machine                           |
| `test` (CI)   | Automated tests                                      | GitHub Actions + service containers                                                                         | Ephemeral, created per run                                       | CI only                                     |
| `staging`     | Pre-production verification, load tests, partner UAT | Same topology as production at smaller size; separate cloud account/project                                 | Synthetic or anonymized. **Never raw production personal data.** | Dev team + partner testers, SSO/MFA         |
| `production`  | Customers                                            | Managed PG (Multi-AZ, PITR), managed Redis (TLS), LB + WAF, private subnets, object storage, secret manager | Real                                                             | Least privilege, MFA, break-glass procedure |

Each environment has **separate** credentials, databases, buckets, secrets and domains. No credential is
shared across environments. Staging cannot reach production data stores.

## Hosting (open decision)

Preferred direction: a major cloud provider's **Tokyo region** with managed PostgreSQL and Redis/Valkey,
running containers on a managed container service (for example AWS ECS Fargate + RDS + ElastiCache + S3 + ALB/WAF).
Kubernetes is not required. The images and health/shutdown contract are orchestrator-agnostic. Final choice
depends on partner preferences, data residency and cost (see 10-implementation-roadmap.md).

## Release flow

```
PR -> CI (format, lint, typecheck, unit + integration + cross-tenant tests, audit, secret scan)
   -> merge to main -> build images once (tag = git SHA) -> scan images (Trivy) + SBOM
   -> deploy to staging: run migrations task -> rolling update -> smoke tests -> (load tests as scheduled)
   -> manual approval (protected GitHub environment) -> production: migrations task -> rolling update
   -> post-deploy health and error-rate watch (automatic rollback trigger on SLO breach, later)
```

- **Same digest** promoted from staging to production. No rebuilds per environment.
- **Migrations:** separate one-off task with the migrator credential, run before app rollout. Every migration is
  backward compatible with the currently running app version (expand → deploy → backfill → contract in a later release).
  Destructive steps (drop or rename) only in a later release after the code no longer uses them.
- **Rollback:** redeploy the previous image digest. Schema stays compatible by the rule above. Data fixes go forward via new migrations.
- **Feature exposure** is controlled by entitlements and global kill switches, not by deploying different code.

## Configuration and secrets

- All configuration via environment variables validated at startup (`packages/config`).
- Secrets come from the platform secret manager, injected at runtime and rotated on schedule or after incidents. Never in images, Git or CI logs.
- CI has no production credentials in Phase 0. Later, deployments use short-lived OIDC federation from GitHub Actions to the cloud account (no long-lived keys).

## Backups and disaster recovery (targets to agree)

- PostgreSQL PITR (for example 14–35 days) plus periodic logical backups to a separate account or region.
- Object storage versioning for brand assets and exports.
- Quarterly **restore drill** into an isolated environment, with timings recorded.
- RPO/RTO targets to be agreed with the partner (proposal: RPO ≤ 5 min, RTO ≤ 1–4 h).
