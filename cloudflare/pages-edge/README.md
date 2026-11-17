# The TOEFL House — non-destructive Pages edge upgrade

This fileset is **a transitional, source-controlled compatibility layer**, not the complete original site source. It proxies every existing route to the immutable verified Pages deployment from 9 November 2026, preserving its React application, forms, CMS/auth, media, SEO course/guides, and D1 bindings.

## Changes
- Enriches public HTML that already allows `'self'` scripts with two **same-origin** assets: `/__th/engagement-v1.js` and `/__th/engagement-v1.css`.
- Records aggregate WhatsApp, phone and admissions **clicks** through the pre-existing independent Cloudflare Worker. It never sends form values, visitor identifiers or phone numbers.
- Records source/campaign from validated UTM parameters or session-scoped attribution without cookies or visitor profiles. No external tracker is added.
- Preserves existing branded UI; adds only keyboard focus and reduced-motion improvements to avoid duplicate nav/CTAs.
- Preserves canonical indexability for normal public routes while preventing preview pages from being indexed.
- Preview refuses all unsafe HTTP methods to protect production CMS data.

## Scope and limits
- SEO course pages intentionally retain their strict `default-src 'none'` policy; those existing outgoing WhatsApp links already use the legacy `/go/whatsapp` click counter and no JavaScript is injected there.
- New D1 `conversion_clicks` totals are click intents, **not** distinct users, delivered messages, answered calls or confirmed enrolments.
- No historical leads can be reconstructed from the new counters.
- **Do not delete the immutable Cloudflare deployment 0c14f299-ea21-4542-8065-f60b839e06f4 or its Nov 5 downstream dependency.**
- The existing Pages project uses Direct Upload. GitHub CI can build and verify releases, but automated production publishing requires a scoped Cloudflare deployment credential configured through an authorized GitHub action/secret.

## Gates before live promotion
1. `node --test cloudflare/pages-edge/tests/*.test.mjs`
2. Syntax and size check for the Pages bundle.
3. Upload to a Preview branch using the existing static manifest and `_worker.js`.
4. Compare homepage EN/FA/PS, course/admissions, sitemap, robots, /api/content, security headers and admin GET (read-only).
5. Verify no redirect to pinned hostname, no robots noindex on canonical, and script files are served.
6. Approve exact preview code for production deployment with verified rollback.

The project is still not a full source consolidation. That requires the original Nov 5 Pages Functions Worker and 9 Nov overlay source.
