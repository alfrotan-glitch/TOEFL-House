import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('WP-13 server and platform contracts stay on their declared authorities', () => {
  it('guards audit visibility with Audit.View and exposes the durable failure side-channel', () => {
    const source = read('server/src/routes/audit.routes.ts');
    expect(source).not.toContain("authorize('general_manager')");
    expect(source).toContain("requirePermission('Audit.View')");
    expect(source).toContain("auditRouter.get(\n  '/failures'");
    expect(source).toContain("SELECT COUNT(*) AS c FROM audit_failures");
    expect(source).toContain("action LIKE ? ESCAPE '\\\\'");
    expect(source).toContain("error LIKE ? ESCAPE '\\\\'");
    expect(source).toContain('parsePagination(req, { defaultPageSize: 200, maxPageSize: 2000 })');
  });

  it('persists failed audit writes instead of discarding them', () => {
    const source = read('server/src/middleware/audit.ts');
    expect(source).toContain('INSERT INTO audit_failures');
    expect(source).toContain('request_id');
    expect(source).toContain('operator_id');
    expect(source).toContain('branch_id');
    expect(source).toContain('payload');
  });

  it('keeps the deployment and release gates on portable, executable audit checks', () => {
    const verifier = read('server/scripts/verify-deployment.mjs');
    const releaseGate = read('scripts/release-validate.mjs');
    expect(verifier).toContain('fileURLToPath');
    expect(verifier).toContain('schema.sql');
    expect(releaseGate).toContain('audit:registries');
    expect(releaseGate).toContain('audit:protocol');
    expect(releaseGate).toContain('audit:cleanliness');
    expect(releaseGate).toContain('audit:deps');
  });
});
