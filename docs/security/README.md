# docs/security/

| Document                                             | Content                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| [security-architecture.md](security-architecture.md) | Trust boundaries, authN, authZ, tenant isolation, privileged ops, controls |
| [qr-ordering.md](qr-ordering.md)                     | QR ordering threat model, join-code design, known limitations              |
| [online-ordering.md](online-ordering.md)             | Online ordering trust boundaries, tracking tokens, PII, anti-spam controls |
| [menu-images.md](menu-images.md)                     | Menu photo uploads: untrusted files, storage keys, tenant isolation        |

Planned (added as implementation starts): `threat-model.md` (STRIDE per module, starting with identity, orders and payments),
`asvs-l2-checklist.md` (requirement → evidence), `incident-response.md` (or under `docs/operations/`), and a vulnerability disclosure process.
