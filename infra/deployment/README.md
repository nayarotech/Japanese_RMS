# infra/deployment/

Production-oriented templates and the **target** deployment design. Nothing here is deployed.
Full rationale: [docs/architecture/09-deployment-strategy.md](../../docs/architecture/09-deployment-strategy.md).

## Target topology (proposal, pending hosting decision)

```
Internet -> CDN/WAF -> Load balancer (TLS, sticky cookie for Socket.IO polling fallback)
              |-- web    (N replicas, stateless)
              |-- api    (N replicas, stateless, Socket.IO + Redis adapter)
Private network:
              |-- worker (M replicas)
              |-- Managed PostgreSQL (Multi-AZ, PITR backups, TLS, private only)
              |-- Managed Redis/Valkey (TLS + auth, private only)
              |-- Object storage (private bucket, signed URLs)
              |-- Secret manager (DB/Redis creds, session secret, provider keys)
```

Recommended region for Japanese customers: a Tokyo region (for example AWS `ap-northeast-1`), with
data residency confirmed with the partner.

## Files

| File                            | Purpose                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.replicas.example.yaml` | Illustrates the _same images_ running as multiple replicas against external managed services. A reference for any orchestrator (ECS, Cloud Run, Nomad, Kubernetes later), not a production manifest. |

## Release contract

1. CI builds images once per commit and tags them by git SHA. Images are scanned.
2. **Migrations run as a separate one-off task** with the migrator credential _before_ new app replicas start.
   Migrations must be backward compatible with the previous app version (expand, migrate, contract).
3. Rolling deploy: new replicas pass `/health/ready`, then old replicas receive SIGTERM and drain.
4. Rollback = redeploy previous image digest. Schema is still compatible because of rule 2.
