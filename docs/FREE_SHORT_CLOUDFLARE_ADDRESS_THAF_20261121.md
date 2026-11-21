# TOEFL House — Free short Cloudflare Pages address

**New public address:** https://thaf.pages.dev/  
**Short name:** THAF (TOEFL House Afghanistan)  
**Cost of domain purchase:** None. Cloudflare's free `.pages.dev` hostname; hosting remains subject to the plan's usage quotas.  
**Date configured:** 21 November 2026.

## What visitors see

- `https://thaf.pages.dev/` opens the **Afghan Dari** version directly, while the short address stays visible in the browser.
- `https://thaf.pages.dev/fa/` also opens Dari.
- `https://thaf.pages.dev/en/` opens English.
- `https://thaf.pages.dev/ps/` opens Pashto.
- Course information, images, CSS/JS and student admissions function through the same short host.
- The existing canonical site **https://the-toefl-house.pages.dev/** is deliberately left running and is the only source of truth for the site and public CMS.

## Architecture and safety

This is a separate, *small* Cloudflare Pages project named `thaf`. It uses a read-only reverse-proxy Module Worker, maintained at [cloudflare/short-alias/thaf-worker.mjs](../cloudflare/short-alias/thaf-worker.mjs), to display the existing public site. Its Pages project has **no copy of the original D1 database**, does not duplicate static assets and does not require a second CMS.

- HTTP GET and HEAD only; no cookies, credentials or student personal data forwarded to the origin.
- Admin/private URLs explicitly redirect to the canonical original domain.
- Short alias carries `X-Robots-Tag: noindex,follow,noarchive`, serves a disallowing `robots.txt`, and preserves the existing canonical meta URLs to prevent duplicate indexing.
- HTML link rewrites keep the English language switch functional even though short-root `/` is Dari.
- Original production source, deployment and CMS configuration were not changed.
- Cloudflare Pages does not support directly changing an existing `pages.dev` hostname; this avoids a destructive project replacement.

## Verified release

- **Cloudflare Pages project:** `thaf` with free hostname `thaf.pages.dev`.
- **Preview deployment:** `9e43e088-b89e-443a-bd85-8b9b6352fc68` — success.
- **Production deployment:** `93ae44dc-99ab-4bd2-8511-6d5211fe8712` — success.
- **Worker source commit:** `6ba67899c89e95c8ebb77bffd0bdedf3d6a2744d`.
- [Preview API acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44864272753): 5/5 pass.
- [Canonical short-domain HTTP and real Chrome browser acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44864462758): **both jobs successful**; verified the Dari root, English/Pashto, language switches, mobile layout, images, program card, admissions form, assets, noindex and protected admin routing. Screenshots are included in this Actions run.
- Two temporary, nonselected projects `th` (`th-70r.pages.dev`) and `tth` (`tth-a2g.pages.dev`) were deleted after the clean `thaf.pages.dev` name was confirmed.

## Maintenance

1. **New public site updates occur on the original Pages project**. Because the short address reads the live public site, routine content updates normally appear through `thaf.pages.dev` automatically; do not edit a second CMS.
2. Updates to the *short alias Worker* must be deployed to the `thaf` Pages project separately; a GitHub edit alone does not deploy this Direct Upload project.
3. Keep the original Pages project and D1 binding active. If the original goes offline, the short address cannot serve its dynamic content independently.
4. Treat `thaf.pages.dev` as a **short entry address**, not a separate SEO domain. For Search Console and structured data, maintain the original canonical hostname until a deliberately planned custom-domain migration.
5. Before advertising, test the address on an actual student phone and verify WhatsApp contact details and current classroom availability.

**Safe rollback:** Stop promoting the short link and use `https://the-toefl-house.pages.dev/fa/`. No database restore is necessary for the alias.
