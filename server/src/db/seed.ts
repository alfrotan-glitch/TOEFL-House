import { ensureFinanceAccount } from '../utils/financeAccounts.js';
// LEGACY_COMPAT_ONLY: saving_accounts remains only for migration/backward compatibility. Runtime uses finance_accounts.
/**
 * TOEFL House ERP — Production Bootstrap
 *
 * Idempotent bootstrap only. No operational/demo records are created.
 * The database connection already initializes schema/migrations/hierarchy when
 * imported, so this file MUST NOT call initSchema() a second time.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './connection.js';
import {
  DEFAULT_BRANCH_ID,
  DEFAULT_BRANCH_CODE,
  ensureOrganizationHierarchy,
} from './organizationHierarchy.js';
import { hashPassword } from '../utils/auth.js';
import { bootstrapRbacCatalog, assignPrimaryRole } from '../core/rbac/rbac-service.js';
import { seedDefaultWorkflowDefinitions } from '../utils/workflowSeeds.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const ownerUsername = required('SEED_OWNER_USERNAME');
const ownerPassword = required('SEED_OWNER_PASSWORD');
const ownerName = required('SEED_OWNER_NAME');
const ownerEmail = required('SEED_OWNER_EMAIL');

if (ownerPassword.length < 12) {
  throw new Error('SEED_OWNER_PASSWORD must be at least 12 characters long.');
}

// connection.ts already ran initSchema(). Calling it again here caused the
// schema/hierarchy bootstrap to execute twice and made the old seed attempt to
// insert the already-created default branch a second time.
console.log('🔄 Verifying production bootstrap hierarchy...');
ensureOrganizationHierarchy(db);

bootstrapRbacCatalog(db);
seedDefaultWorkflowDefinitions();

const branchCode = process.env.SEED_BRANCH_CODE?.trim() || DEFAULT_BRANCH_CODE;
const branchId = process.env.SEED_BRANCH_ID?.trim() || DEFAULT_BRANCH_ID;

// Resolve the configured branch without ever blindly inserting a duplicate.
const branchById = db.prepare(`
  SELECT id, code, name, campus_id, is_active
  FROM branches WHERE id = ?
`).get(branchId) as {
  id: string; code: string | null; name: string; campus_id: string | null; is_active: number;
} | undefined;

const branchByCode = db.prepare(`
  SELECT id, code, name, campus_id, is_active
  FROM branches WHERE UPPER(code) = UPPER(?)
`).get(branchCode) as typeof branchById;

if (branchById && branchByCode && branchById.id !== branchByCode.id) {
  throw new Error(
    `Branch configuration conflict: SEED_BRANCH_ID=${branchId} and ` +
    `SEED_BRANCH_CODE=${branchCode} refer to different branches. Refusing to continue.`
  );
}

const branch = branchById || branchByCode;
if (!branch) {
  throw new Error(
    `Configured bootstrap branch does not exist (id=${branchId}, code=${branchCode}). ` +
    'Create the branch through the hierarchy configuration first; bootstrap will not silently invent a second branch.'
  );
}

if (!branch.is_active) {
  throw new Error(`Bootstrap branch ${branch.code || branch.id} is inactive. Refusing to create an owner on an inactive branch.`);
}

const passwordHash = await hashPassword(ownerPassword);

const passwordWasGeneratedForFirstInstall = process.env.BOOTSTRAP_OWNER_PASSWORD_GENERATED === '1';

const bootstrap = db.transaction(() => {
  // Saving account is infrastructure and idempotent.
  db.prepare(`
    INSERT OR IGNORE INTO saving_accounts (branch_id, balance) VALUES (?, 0)
  `).run(branch.id);
  ensureFinanceAccount('branch', branch.id);

  const existingOwner = db.prepare(`
    SELECT id, username, full_name, email, branch_id, is_active
    FROM users WHERE LOWER(username) = LOWER(?)
  `).get(ownerUsername) as {
    id: string; username: string; full_name: string; email: string; branch_id: string | null; is_active: number;
  } | undefined;

  if (existingOwner) {
    // Never overwrite an existing user's password during a rerun.
    // This makes the bootstrap safe and prevents accidental credential rotation.
    if (existingOwner.branch_id !== branch.id) {
      throw new Error(
        `Owner username '${ownerUsername}' already exists on another branch. ` +
        'Refusing to reassign the existing account automatically.'
      );
    }
    if (!existingOwner.is_active) {
      throw new Error(`Owner account '${ownerUsername}' exists but is inactive.`);
    }
    if (passwordWasGeneratedForFirstInstall) {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 1, full_name = ?, email = ?, branch_id = ?
        WHERE id = ?
      `).run(passwordHash, ownerName, ownerEmail, branch.id, existingOwner.id);
      assignPrimaryRole(db, existingOwner.id, 'owner', null, 'bootstrap');
      return { action: 'credentials-reset' as const, userId: existingOwner.id };
    }
    return { action: 'existing' as const, userId: existingOwner.id };
  }

  const userId = randomUUID();
  db.prepare(`
    INSERT INTO users (
      id, username, password_hash, full_name, email, branch_id,
      is_active, must_change_password
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)
  `).run(userId, ownerUsername, passwordHash, ownerName, ownerEmail, branch.id);

  // The account's authority is the assignment, not anything on the user row.
  assignPrimaryRole(db, userId, 'owner', null, 'bootstrap');

  return { action: 'created' as const, userId };
});

const result = bootstrap();

if (passwordWasGeneratedForFirstInstall) {
  const envPath = resolve(process.cwd(), '.env');
  const content = readFileSync(envPath, 'utf8').replace(/^BOOTSTRAP_OWNER_PASSWORD_GENERATED=1$/m, 'BOOTSTRAP_OWNER_PASSWORD_GENERATED=0');
  writeFileSync(envPath, content);
}

console.log('');
console.log('✓ Production bootstrap completed successfully.');
console.log(`✓ Bootstrap branch: ${branch.name} (${branch.code || branch.id})`);
console.log(`✓ Owner account: ${ownerUsername} (${result.action})`);
console.log('✓ No operational/demo students, leads, teachers, payments, expenses, donors, or campaigns were created.');
console.log('✓ Existing operational data was not deleted or modified.');
if (result.action === 'created' || result.action === 'credentials-reset') {
  console.log('✓ Bootstrap credentials are active; the owner must change the password on first login.');
} else {
  console.log('✓ Existing owner credentials were preserved; no password was overwritten.');
}
