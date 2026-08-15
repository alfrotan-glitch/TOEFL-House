# Build and Lockfile Policy

The backend is reproducible from `server/package-lock.json` and is installed with `npm ci --include=dev`.
The frontend currently has no committed root `package-lock.json`; the release gate therefore uses `npm install --package-lock=false` for validation. A root lockfile must be generated and committed before production certification.
