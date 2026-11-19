# src/shared/

Deliberately **small**. Only cross-cutting code with no business meaning belongs here.

| Directory     | Responsibility                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors/`     | Base `AppError` hierarchy (`NotFound`, `Forbidden`, `FeatureNotEntitled`, `Conflict`, `ValidationFailed`…) and mapping to HTTP/WS responses. |
| `middleware/` | Generic Express middleware (request id, error handler, Zod validation helper, async wrapper).                                                |
| `types/`      | Branded ID types (`TenantId`, `LocationId`…), `Result` helpers, and the shared `AccessContext` type contract.                                |

If something here starts referencing menus, orders, plans or any other business concept, move it into the owning module.
