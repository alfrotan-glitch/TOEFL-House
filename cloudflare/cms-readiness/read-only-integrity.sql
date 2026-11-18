-- Read-only CMS health inspection. No UPDATE, DELETE, INSERT, REPLACE or RESTORE.
-- Run each statement separately in the authorized Cloudflare D1 query console.
-- Output is counts/flags only. Never SELECT staff usernames, password/TOTP fields,
-- session token hashes, invitation hashes, private drafts or unpublished JSON bodies.

-- Current published content and JSON validity.
SELECT revision, json_valid(body) AS json_ok FROM content WHERE id='main';
SELECT revision, json_valid(body) AS json_ok FROM pashto_content WHERE id='main';

-- Revision continuity and JSON integrity.
SELECT COUNT(*) AS entries, MIN(revision) AS first_revision,
  MAX(revision) AS last_revision,
  SUM(CASE WHEN json_valid(body)=0 THEN 1 ELSE 0 END) AS malformed
  FROM revisions;
SELECT COUNT(*) AS entries, MIN(revision) AS first_revision,
  MAX(revision) AS last_revision,
  SUM(CASE WHEN json_valid(body)=0 THEN 1 ELSE 0 END) AS malformed
  FROM pashto_revisions;

-- Drafts must be inspected by authorized Owner if behind production.
SELECT COUNT(*) AS count,
 SUM(CASE WHEN base_revision < (SELECT revision FROM content WHERE id='main')
   THEN 1 ELSE 0 END) AS stale_drafts,
 SUM(CASE WHEN json_valid(body)=0 THEN 1 ELSE 0 END) AS malformed_drafts
 FROM drafts;

-- Archive must be retained, not automatically purged.
SELECT COUNT(*) AS archived,
 SUM(CASE WHEN json_valid(draft_body)=0 THEN 1 ELSE 0 END) AS malformed_archives
 FROM cms_draft_recovery_archive;

-- Staff access: counts only, no usernames or secrets.
SELECT role,enabled,COUNT(*) AS staff_count,
 SUM(CASE WHEN length(totp_secret)>0 THEN 1 ELSE 0 END) AS mfa_configured
 FROM staff_users GROUP BY role,enabled;

-- Old sessions/invitations may be audited, but do not automatically delete.
SELECT COUNT(*) AS all_sessions,
 SUM(CASE WHEN expires_at <= CAST(strftime('%s','now') AS INTEGER)
   THEN 1 ELSE 0 END) AS expired_sessions
 FROM sessions;
SELECT COUNT(*) AS total_invites,
 SUM(CASE WHEN consumed_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER)
   THEN 1 ELSE 0 END) AS valid_unconsumed
 FROM onboarding_invites;

-- D1 supports foreign key checking. A successful query returns no rows.
PRAGMA foreign_key_check;
