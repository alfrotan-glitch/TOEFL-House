# Official brand assets

`toefl-house-logo.png` is the **official TOEFL House logo**, supplied by the
institute (8499 × 4162 PNG, RGBA). It is the single canonical copy used by every
branded surface: screens, print sheets, receipts, invoices, ID cards,
certificates, reports and the favicon.

## Rules

- Do **not** redesign, redraw, recreate, approximate, recolour or distort it.
- Do **not** copy it elsewhere in the repository. Every consumer references it
  through `src/config/branding.ts` (`BRAND_LOGO_URL`), and
  `branding-consistency.test.ts` fails the build if a second logo file appears.
- To rebrand, replace this one file, or edit `src/config/branding.ts` — nothing
  else should need to change.

The official slogan is exactly **"Unlock the world with TOEFL"** and lives in
the same module as `BRAND_SLOGAN`.

## Verification

```bash
cd server && npx vitest run src/tests/branding-consistency.test.ts   # 6/6
cd ..     && npm run release:validate                                # includes the asset check
```
