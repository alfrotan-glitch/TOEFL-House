# Textbook library candidate — 2026-11-28

## Scope and provenance

Adapted the trilingual textbook library from PR #58, tip `7c3cfff`, onto the recovery branch rather than merging its conflicting branch. Four book guides in each of English, Dari and Pashto link from the General English and Academic English pages. The edge sitemap and guide renderer share a route list. Existing curriculum statements are consistent with the checked-in `cloudflare/site-v2/GENERAL_ENGLISH_CONTENT.md` and `DEEP_AUDIT_20261120.md`; the school should still review current materials and translations before publication. The exercises are original rather than copies of publisher material. Use of books does not imply publisher endorsement.

The index separates books from practical guides, uses a two-column desktop book layout, and presents concise book names. English book names and selected English phrases in RTL guide content are isolated with language and direction markup. SEO metadata keeps the longer localized descriptions. A manual local screenshot inspection exposed and corrected a mixed-script title ordering problem; this is not a substitute for fluent-language review or screen-reader testing.

## Local candidate evidence

- Build output: 394,426 bytes; SHA-256 `dc62088914cf0bdc8498e07b7ed00bf358ba5fe51b0ddb31ed53ceaab0951078`.
- CSS source: 75,957 bytes against a 76,000-byte ceiling; built CSS: 75,756 bytes. Client JS: 9,623 bytes against 10,000. The small remaining budgets need structural attention; they were not raised for this change.
- 118 offline Node tests passed, excluding the network-dependent historical preview test. Browser harness: 51 sitemap routes at 320, 390, 768, 1024, 1440 and 1920 pixels (306 route/viewport checks); automated axe scan of the main region of 12 book guides and three practice panels reported zero violations.
- Screenshots under `.sandbox/candidate-screenshots/` are local, with intercepted requests and synthetic CMS content; representative English/Dari/Pashto library and book pages are captured at 390 and 1440 pixels. External imagery is blocked. They are not evidence of production assets or Cloudflare bindings.

## Open gates

No candidate Cloudflare deployment, binding verification, live exact-artifact comparison, production deployment, or application submission has occurred. The local browser checks are not a full visual audit, user test, WCAG certification, Lighthouse or field Core Web Vitals measurement. Fact, translation, copyright/trademark and visual review remain required. PR #58 remains open; this adaptation does not authorize closing it. PR #60 still needs authentic owner-supplied imagery. The site-wide premium redesign, responsive visual review, infrastructure investigation and non-destructive branch/workflow consolidation are not complete.
