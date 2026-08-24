# Resilience and Security Architecture

## Resilience

Durable committed facts, financial transactions, audit evidence, configuration versions, and document metadata require backup coverage and restoration verification. Recovery preserves ordering, idempotency, period integrity, and reconciliation evidence. Degraded operation may read cached non-authoritative data but must not accept unsafe financial or authority mutations. RPO, RTO, retention, and disaster priorities remain explicit operational requirements awaiting organization-specific values; no infrastructure vendor is selected.

## Security

Authentication establishes an account identity; authorization is a separate server-side policy boundary. Sessions/tokens are bounded by expiry, revocation, secure transport, and audience; passwords/secrets require protected handling and rotation policy. Privilege escalation is prevented by default deny, server checks, immutable authority history, SoD, and conflict exclusion. Sensitive data is encrypted in transit/at rest according to policy, minimized in logs, and protected by purpose/scope. Exports and integrations use the same authorization, consent, classification, and audit controls.
