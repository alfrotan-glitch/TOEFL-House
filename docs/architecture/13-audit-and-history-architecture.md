# Audit and History Architecture

A material audit event records actor/person, authority decision and policy version, scope, operation, target, previous value/state, resulting value/state, reason, effective timestamp, recorded timestamp, correlation/reference ID, approval relationship, source, and outcome. It is append-only, access-controlled, retained by policy, and independent of mutable operational logs.

Owner transactions commit business fact and required audit evidence together. Cross-context notifications carry correlation IDs and produce receiving audit evidence. Historical records are immutable; current state, transfer, configuration, correction, reversal, appeal, and deactivation append linked facts. Audit does not become a business source of truth.
