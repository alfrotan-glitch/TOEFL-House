# Observability Architecture

Structured operational telemetry includes correlation/reference ID, context, operation, outcome, latency, retry, actor class (not unnecessary personal data), and failure category. Distributed tracing follows a command across contexts and integrations. Metrics cover availability, latency, job backlog/failure, authorization denials/anomalies, projection freshness, financial reconciliation variance, and period-close exceptions.

Health checks distinguish process health, dependency health, and business readiness. Audit records are authoritative history; logs and metrics are diagnostic and must not replace audit. Financial alerts route to Finance and remain linked to reconciliation evidence. Sensitive values are redacted and telemetry access is scoped and audited.
