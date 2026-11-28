# Original book-exercise feedback — 28 November 2026

## Scope

Each of the four book guides now provides a native HTML disclosure with original, localized self-check guidance in English, Dari and Pashto. The reading exercise identifies its main idea and supporting details; the writing exercise includes one original example paragraph with English language/direction metadata; the routine and listening exercises explain what to check without pretending there is only one correct answer. This is feedback for original exercises, not copied textbook content or a publisher affiliation. It works without JavaScript. Fluent-language, educational and institutional review are still required.

## Exact local candidate

- Worker SHA-256: `9ff12c93114f2f1040726c3f8c0ec3a982c2275ba1219f85cf917da021b17429`, 397,435 bytes (2,565 below the existing ceiling). CSS source 74,994 bytes (1,006 below its ceiling); served CSS 74,794 bytes, gzip level 9 14,816 bytes, Brotli Node default 12,769 bytes. Client JS remains 9,623 bytes. No size limits were raised.
- 120 offline Node tests passed. Browser checked all 51 routes at six widths (306 combinations); axe ran on all 51 initial mobile pages with zero reported WCAG 2/2.1 A/AA violations. All 12 feedback disclosures opened with the keyboard and were scanned within the book main region with zero reported violations; one disclosure per language also opened without JavaScript. Existing practice, focus restoration, card hit-area and read-only preview checks passed. These are not a WCAG certification or a complete manual assistive-technology audit.
- Against the preceding `da86a0e` candidate, all 306 initial viewport PNGs were byte-identical. Full-page comparison: 75/102 were byte-identical; 24 changes were the 12 book pages at two widths, as intended; three unrelated home screenshots differed by three or four anti-aliased video-frame pixels. Open disclosure screenshots were saved for each book/language under `.sandbox/education-final-screenshots/`; full-page files are in `.sandbox/fullpage-education-final/`. They use synthetic CMS and unavailable production imagery.
- Local Lighthouse 12.8.2, mobile, synthetic CMS and no external images: the three reading-guide locales scored 99–100 performance, 100 accessibility and 100 best practices, with LCP 1.44–2.11 seconds and CLS 0 in these samples. SEO was 69 due to `is-crawlable` on intentionally noindexed previews. These results do not prove field INP, real Cloudflare performance or production SEO.

No Cloudflare preview, production release, binding verification, real application submission or database change has occurred. The site-wide design and visual review remain unfinished; see `CSS_WORKER_AUDIT_20261128.md` for architecture, prior comparison and outstanding gates.
