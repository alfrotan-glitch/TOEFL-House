# ADR-001: Architectural Style

**Decision:** modular monolith with strict bounded-context boundaries, one controlled deployment unit initially, and explicit seams for future extraction.

**Context:** TOEFL House has strong cross-domain transaction and audit requirements, a single institutional business model, substantial financial consistency needs, and no authorized scale/team assumptions requiring distributed deployment.

**Alternatives:** Microservices improve independent scaling/failure isolation but add distributed transactions, operational cost, contract/version overhead, and more reconciliation. SOA offers service boundaries but similar coordination cost without a present organizational benefit. A layered unbounded monolith risks hidden coupling and duplicate authority.

**Rationale:** modular monolith minimizes deployment complexity while preserving domain ownership, atomic financial operations, deterministic tests, and auditability. Context contracts, separate persistence ownership, and asynchronous post-commit integration prevent it becoming a shared-data monolith.

**Consequences:** one failure domain initially; module boundaries and contracts must be enforced structurally. Extraction is possible later only with evidence and a new decision. No framework or vendor is selected.
