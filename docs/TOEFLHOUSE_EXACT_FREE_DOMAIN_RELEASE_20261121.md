# TOEFL House — Exact Full-Brand Free Cloudflare Address

**Preferred public address:** https://toeflhouse.pages.dev/  
**Status:** SUCCESS — live Cloudflare Pages production and real Chrome acceptance on 21 November 2026.  
**Domain registration fee:** None; this is a Cloudflare-provided `.pages.dev` subdomain, not ownership of `toeflhouse.com` or `toeflhouse.af`.

## Verified address allocation
Cloudflare created a project with `name=toeflhouse` and assigned the **exact** hostname `toeflhouse.pages.dev` without an arbitrary suffix. This is more descriptive and easier for visitors to associate with the institution than the shorter but obscure `thaf.pages.dev`.

- Project ID: `0fa45c13-ae88-498d-ab3f-e0ed2070d639`
- Production deployment ID: `c503c2fe-4254-4998-9c6e-2f59e06d0676`
- Deployment status: `success`
- Worker source commit: `5ea5be845294c73361c764182e565acec9857d07`
- Worker source: `cloudflare/short-alias/toeflhouse-worker.mjs`
- New alias owns **no CMS copy and no D1 data**. Its read-only Cloudflare Pages Worker safely serves pages from `the-toefl-house.pages.dev`.

## Paths and behavior

- `https://toeflhouse.pages.dev/` — Afghan Dari homepage, in place under the new hostname.
- `https://toeflhouse.pages.dev/fa/` — Dari page.
- `https://toeflhouse.pages.dev/en/` — English page.
- `https://toeflhouse.pages.dev/ps/` — Pashto page.
- Public course details, free-placement admissions, campus images, CSS and JS work via the new URL. The short alias does not transmit incoming cookies, credentials, or private student details to the original site.
- Private CMS/admin routes are not directly served by the alias.
- Alias sends `X-Robots-Tag: noindex, follow, noarchive` and `robots.txt` disallow to prevent search duplication; the original domain remains the SEO canonical.

## QA evidence

- Preview Pages deployment `e5dae4ba-1d75-4844-a67f-28a7713bd87f`: Cloudflare status **success**, but the deep preview hostname initially produced an HTTPS certificate mismatch; do **not** use its URL in advertising.
- Production Pages `toeflhouse.pages.dev`: Cloudflare status **success**.
- [Live production acceptance](https://github.com/alfrotan-glitch/TOEFL-House/actions/runs/44865056104): **both suites successful**.
  - Public HTTP smoke suite: five groups testing homepage Dari, three locales, enrollment and course routing, public assets, noindex security and private admin isolation.
  - Chrome mobile E2E suite: real 390×844 view, logo and layout, language switches, course-card navigation, admissions preselection and tuition summary. Includes screenshot artifact.
- The original school site remains `https://the-toefl-house.pages.dev/` and is untouched, with production `CMS_DB` binding retained.
- The previous free short URL `https://thaf.pages.dev/` also remains active as a fallback; not deleted or changed.

## Advertising usage

Use **toeflhouse.pages.dev** (without `https://`) as the short readable text in print, video, posters, Facebook, WhatsApp and QR-code labels. The actual clickable link should use `https://toeflhouse.pages.dev/`. Make sure the legally correct use of the TOEFL trademark in an independent school's registered/public-facing name and domain has been independently confirmed; technically available does not imply trademark permission.

## Limitations

- The address is **not** a purchased custom domain; `pages.dev` remains part of it.
- If the original Pages project or live CMS goes offline, the alias does not have an independent copy of the school website.
- Origin links with intentional absolute canonical URLs can take visitors to the original site; public tests verified the required major journeys.
- Avoid adding another search-indexed duplicate domain until planning an SEO migration.
- Future changes to the short alias Worker require a separate Direct Upload deployment, while ordinary published school content is read from the original site.
