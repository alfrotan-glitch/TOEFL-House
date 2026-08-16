# Official brand assets

## ⚠ ACTION REQUIRED — the official logo is not yet in the repository

`toefl-house-logo.png` is **missing**. Everything else is already wired to it;
this one file is all that remains.

### To install it

Copy the official PNG (supplied by the institute — the wordmark with the red
"TOEFL", the grey roof outline, and the slogan "Unlock the World with TOEFL")
to exactly this path:

```
public/brand/toefl-house-logo.png
```

Then verify:

```bash
cd server && npx vitest run src/tests/branding-consistency.test.ts   # 6/6
cd ..     && npm run build && ls dist/brand/                          # asset copied
```

That is the whole procedure. No code change is required: every consumer already
reads the path from `src/config/branding.ts`.

The pipeline was verified end-to-end during the audit using a temporary
throwaway file — with an asset present the branding suite passes 6/6 and the
build copies it into `dist/brand/`. The throwaway was deleted rather than
committed, because recreating or approximating the logo is explicitly
forbidden.

## Rules

`toefl-house-logo.png` is the **official TOEFL House logo**. It is the single
canonical copy used by every branded surface (screens, print sheets, receipts,
invoices, ID cards, certificates, reports, favicon).

- Do **not** redesign, redraw, recreate, approximate, recolour or distort it.
- Do **not** copy it elsewhere in the repository. Every consumer references it
  through `src/config/branding.ts` (`BRAND_LOGO_URL`), and a test fails the
  build if a second logo file appears.
- To rebrand, replace this one file, or edit `src/config/branding.ts` —
  nothing else should need to change.
