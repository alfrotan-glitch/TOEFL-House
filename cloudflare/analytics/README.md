# The TOEFL House — conversion link service

This directory versions the **actual Worker deployed** at `https://toefl-house-conversions.alfrotan2.workers.dev`.

The independent production website is `https://the-toefl-house.pages.dev`. Its current exact Pages frontend and Functions source are **not** in this repository.

## Live functionality

| Route | What counts | Destination |
| --- | --- | --- |
| `/wa?s=facebook&c=campaign&p=toefl-preparation` | Click on marketing WhatsApp link | Official admissions WhatsApp |
| `/call?s=facebook&c=campaign&p=toefl-preparation` | Click on marketing telephone link | Official `tel:` link |
| `/apply?s=facebook&c=campaign&p=toefl-preparation` | Click on admissions-link CTA | Pages admissions page |
| `/health` | Service health | JSON status |

Source, campaign and course are constrained to short alphanumeric, underscore or hyphen labels. No name, phone number, message text or email is saved in the Worker D1 table. The totals represent **clicks**, not completed WhatsApp conversations, successful calls or confirmed student enrolments.

The Worker uses a separate D1 database `toefl-house-conversions`, not the website CMS database. Its table `conversion_clicks` aggregates by day, action, source, campaign and course.

## Reproducibility and testing

Node 20+: `node --test cloudflare/analytics/tests/*.test.mjs`

The worker config is `wrangler.jsonc`; deploy only after reviewed CI and approved Cloudflare authorization. The existing live Worker is configured in Cloudflare and should not be replaced by an untested GitHub Action.

## Important website deployment constraint

The Pages project was created with **Direct Upload**. Cloudflare does not support converting that exact project to its native Git integration. GitHub Actions + Wrangler is supported once the **matching website source and Pages Functions source** are recovered, and a securely scoped deployment token is provided.

The existing `alfrotan-glitch/TOEFL-House` repository is primarily a **separate Laravel web application** and should not be published over the current Pages site. Replacing the deployed Pages Functions without the full original source could disrupt the content-management system, languages, admission flows and production D1 bindings. Keep the production website and CMS unchanged until a matching, testable source and rollback plan exist.

For the website, the release gate is: full source recovery → isolated preview → mobile/RTL/English/SEO/security/form/analytics acceptance → production deployment → verified rollback.
