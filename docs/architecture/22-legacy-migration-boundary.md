# Legacy Migration Boundary

Migration is not assumed until a business decision confirms whether legacy data must be preserved. If required, it is a one-way controlled import into Foundation-owned boundaries: inventory and classify legacy data as evidence, map only with approved canonical mappings, validate identity/relationships/statuses, reconcile financial totals and historical attribution, and quarantine unmappable or conflicting records.

Legacy tables, APIs, routes, services, naming, calculations, permissions, and workflows are not architecture authorities. Cutover requires parallel reconciliation, acceptance by domain owners, a documented point-in-time boundary, audit of imports, and rollback by quarantining/reversing the import rather than rewriting Foundation facts. Existing code may be inspected only for constraints and data evidence.
