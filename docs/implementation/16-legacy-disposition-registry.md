# Legacy Disposition Registry

| Legacy component | Disposition | Basis |
|---|---|---|
| Existing tables/schema | UNKNOWN pending migration decision; otherwise REPLACE | Foundation owns persistence |
| Existing APIs/routes | DEPRECATE/REPLACE | not authority or contract |
| Existing services/workflows | REBUILD | behavior is untrusted |
| Existing UI/screens | REPLACE | UI never authority |
| Existing financial calculations/balances | REPLACE | Finance transaction model wins |
| Existing authorization/RBAC | REPLACE | Position+Assignment+Permission+Scope+Policy wins |
| Existing tests/fixtures | RETAIN as evidence only; rebuild verification | cannot certify new behavior |
| Historical records/data | MIGRATE only if separately approved | validate, reconcile, preserve history |
| Existing naming | UNKNOWN; use canonical registry | naming cannot define ownership |

No legacy artifact is retained as a source of truth without explicit Foundation reconciliation.
