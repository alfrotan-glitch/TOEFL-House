# Startup / Health Readiness Fix — 2026-08-14

## Problem addressed

`run-all.bat` waited 45 seconds for `http://localhost:4000/api/health`. Bootstrap could complete while the backend still failed during startup, or the backend could take longer during event recovery. The previous launcher then reported only a generic timeout.

## Changes

1. Backend now binds its HTTP listener before running the application bootstrap.
2. `/api/health` reports explicit states: `bootstrapping`, `failed`, `ready`.
3. `/api/ready` is provided for readiness probes.
4. All `/api/*` business routes fail closed with HTTP 503 until bootstrap is complete.
5. Startup exceptions are retained in the health response and logged.
6. `run-all.bat` reads the configured PORT from `server/.env`, probes `127.0.0.1`, and waits up to 120 seconds.
7. On timeout, the launcher prints the health response and the last 80 lines of `server/logs/backend-startup.log`.
8. `run-backend.bat` verifies the real `tsx.cmd` executable, installs dev dependencies from the lockfile when necessary, and captures startup output through `Tee-Object`.

## Safety property

The API cannot accept business traffic while bootstrap is incomplete. Health/readiness are the only intentionally public startup endpoints.

## Validation limitation

The supplied ZIP does not contain `node_modules`, and the audit environment cannot complete an online npm install. Therefore no claim is made that a full runtime build/test was executed here. The change was inspected statically and the startup logic was checked for consistency.
