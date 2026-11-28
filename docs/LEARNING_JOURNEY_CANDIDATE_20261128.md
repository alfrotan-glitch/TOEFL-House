# Learning journey milestone — 28 November 2026

This is a candidate milestone in the wider, unfinished flagship transformation, not an authorization to deploy. It extends all seven existing guides in English, Dari and Pashto, without adding a learning account, tracking, client-side dependency or fabricated publisher material.

## What changed

- Each of 21 localized guide articles has a numbered table of contents linked to its own sections, a route back to the library, and two curated, localized related guides. Related book cards link to existing resources and do not claim that a book is required. Program guides link to their related program; the book guides retain their existing publisher and program links. The original exercise, private scratchpad, self-check, and admissions path remain intact.
- The reading layout uses the shared red/white design signature, a wide readable article with navigation rail on desktop, stacked navigation on mobile, and logical-direction borders and spacing. The short mixed-script TOEFL iBT mark stays together in RTL headings. Native links work without JavaScript.
- The TOEFL format guide now links directly to the [official ETS test-content page](https://www.ets.org/toefl/test-takers/ibt/about/content.html?version=after-jan-2026), which was read on 28 November 2026 and describes current task types and the 1–6 score scale. Institutional, educational, legal and translation review remain necessary.

## Evidence and limits

Built Worker SHA-256 `da6cb657a0c7c27244bcc8f3a642a7fe8e5f682069a36f37ca000a8906c2a9f1`; 409,829 raw bytes / 124,605 gzip. Combined CSS source 83,539 bytes / served CSS 82,135 raw and 16,309 gzip; client JS 9,765 raw. Budgets pass but CSS source has only 461 bytes before its internal 84,000-byte fail boundary. The next design milestone needs substantive CSS consolidation or a separately reviewed architectural/budget decision; do not repeatedly loosen ceilings or strip readable source solely to evade the limit.

133 offline site/edge/analytics tests passed. The isolated compiled-Worker browser test passed 51 routes at six widths (306 checks), all 51 initial mobile axe scans, 21 localized guide contents and related-guide keyboard paths, 12 book exercise/feedback checks, and no-JavaScript checks in three locales. A preliminary keyboard-navigation test exposed a test timing race; waiting for navigation fixed the test and the final run passed. Automated scans are not WCAG certification. The browser fixture uses synthetic CMS data and blocks external media; neither actual Pages bindings nor production imagery was tested.

Screenshot sets `.sandbox/visual-signature-final/` (before) and `.sandbox/visual-guide-final/` (after) have 306 matching paths. There are 126 intended changed guide-article viewports and one additional differing PNG on `/ps/admissions/` at 1920px: ImageMagick reports 20 differing pixels in an 82×117 bounding box; the cause is unproven. The remaining 179 PNGs were byte-identical. Full-page samples are in `.sandbox/fullpage-guide-final/`. PNG differences and synthetic fixture screenshots do not establish live performance, visual quality on actual images, or deployed behavior.

## Open release gates

See `OPERATOR_HANDOFF_CANDIDATE.md`. Exact-candidate provider isolation and deployed-byte identity, current production asset parity, six HTML 404 responses, manual assistive-technology and translation review, live performance, #56 owner approval, and Vercel investigation remain open. No release or merge is approved by these local checks. Continue the rest of the site-wide visual, educational and architectural transformation; this milestone does not complete it.
