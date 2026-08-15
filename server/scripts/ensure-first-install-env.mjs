import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '..');
const envPath = resolve(serverDir, '.env');
const examplePath = resolve(serverDir, '.env.example');

const jwtSecret = randomBytes(48).toString('hex');
const ownerPassword = randomBytes(18).toString('base64url');
const PLACEHOLDER_PASSWORDS = new Set([
  'replace-with-a-strong-password-at-least-12-characters',
  'change-this-to-a-strong-password',
]);
const PLACEHOLDER_JWT_SECRETS = new Set([
  'change-this-to-a-long-random-secret-in-production',
  'dev-only-secret-change-me',
]);

const required = (name, fallback) => process.env[name]?.trim() || fallback;

function escapeReplacement(value) {
  return value.replace(/[$\\]/g, '\\$&');
}

function readEnvValue(content, name) {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(content);
  return match?.[1]?.trim() ?? '';
}

const envExists = existsSync(envPath);
const contentSource = envExists ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');
const existingJwtSecret = process.env.JWT_SECRET?.trim() || readEnvValue(contentSource, 'JWT_SECRET');
const existingOwnerPassword = process.env.SEED_OWNER_PASSWORD?.trim() || readEnvValue(contentSource, 'SEED_OWNER_PASSWORD');
const ownerPasswordGenerated = !envExists || PLACEHOLDER_PASSWORDS.has(existingOwnerPassword) || !existingOwnerPassword;
const jwtSecretGenerated = !envExists || PLACEHOLDER_JWT_SECRETS.has(existingJwtSecret) || !existingJwtSecret;
let content = contentSource;

const values = {
  JWT_SECRET: jwtSecretGenerated ? jwtSecret : existingJwtSecret,
  PORT: required('PORT', '4000'),
  JWT_EXPIRES_IN: required('JWT_EXPIRES_IN', '12h'),
  DB_PATH: required('DB_PATH', './data/erp.sqlite'),
  CORS_ORIGIN: required('CORS_ORIGIN', 'http://localhost:3000'),
  SEED_OWNER_USERNAME: required('SEED_OWNER_USERNAME', 'owner'),
  SEED_OWNER_PASSWORD: ownerPasswordGenerated ? ownerPassword : existingOwnerPassword,
  SEED_OWNER_NAME: required('SEED_OWNER_NAME', 'System Owner'),
  SEED_OWNER_EMAIL: required('SEED_OWNER_EMAIL', 'owner@example.com'),
};

for (const [name, value] of Object.entries(values)) {
  const line = `${name}=${escapeReplacement(value)}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(content)) {
    content = content.replace(pattern, line);
  } else {
    content += `\n${line}\n`;
  }
}

writeFileSync(envPath, content.replace(/\n{3,}/g, '\n\n'), { encoding: 'utf8', mode: 0o600 });

console.log('[SUCCESS] server/.env is ready.');
if (ownerPasswordGenerated) {
  console.log(`OWNER_USERNAME=${values.SEED_OWNER_USERNAME}`);
  console.log(`OWNER_PASSWORD=${values.SEED_OWNER_PASSWORD}`);
  console.log('Save these first-install credentials securely. The owner must change the password after first login.');
}
