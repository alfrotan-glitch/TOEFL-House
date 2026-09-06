# Error and Exception Contract

Categories are validation, authorization, business rejection, concurrency conflict, integration failure/unknown outcome, system failure, and emergency exception. Each returns stable category/code, safe message, correlation ID, and retry/hold guidance; internals and sensitive data are not exposed. Material denial, hold, emergency action, and recovery are audited. Financial unknown outcomes go to reconciliation; system recovery replays idempotent post-commit jobs, never unsafe commands.
