# Error and Exception Architecture

Validation failure means malformed/incomplete input; authorization failure means denied authority/scope; business rejection means valid request violates a rule/state; concurrency conflict means state changed and requires retry/review; integration failure means external uncertainty/failure; system failure means infrastructure inability; emergency exception is a specifically authorized, time-limited path.

Responses expose stable business error categories and reference IDs, not stack traces or internal details. Material failures and emergency actions are audited with actor, authority, scope, reason, and outcome. Financial ambiguity is held for reconciliation; no retry may duplicate a transaction. System recovery replays idempotent post-commit work, not business commands without keys.
