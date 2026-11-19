# infra/compose/

Local development only. `compose.yaml` runs:

- **postgres** (18) and **redis** (8) by default, bound to `127.0.0.1`;
- **api, worker, web, proxy** only with `--profile apps` (these images build once the apps are implemented).

`postgres/init/01-roles.sh` runs on first volume creation and creates the `migrator` and `app` roles
(least privilege, no `BYPASSRLS`) plus the `app` schema. It creates **no tables**.

Reset local data: `docker compose -f infra/compose/compose.yaml down -v` (destroys local volumes).

This is **not** a production topology: single instances, no backups, no TLS, no HA.
