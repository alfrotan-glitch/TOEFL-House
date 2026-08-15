# Bootstrap Fix — `tsx is not recognized`

## Root cause
`bootstrap.bat` and `run-backend.bat` only checked whether `server\\node_modules\\` existed. A partial or production-only install could therefore bypass `npm ci`, while the `seed` script required the dev dependency `tsx`.

Observed failure:

```text
> npm run seed
> tsx src/db/seed.ts
'tsx' is not recognized as an internal or external command
```

## Fix
Both Windows entry points now verify the actual executable:

```text
server\\node_modules\\.bin\\tsx.cmd
```

If it is missing they run:

```text
npm ci --include=dev
```

Then they verify `tsx.cmd` exists before continuing. Bootstrap fails closed if it is still missing.

## Result
A stale/partial `node_modules` directory can no longer make the installer skip dependency installation and continue into a guaranteed `tsx` failure.

## Validation limitation
The audit environment could not complete `npm ci --include=dev`; dependency installation is environment/network constrained. The fix was therefore validated structurally against `server/package.json` and `server/package-lock.json`, which both declare/lock `tsx`.
