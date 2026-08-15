import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = process.cwd();
const failures = [];
const warnings = [];

const exists = p => fs.existsSync(path.join(root, p));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'work_rc2', 'work_final', 'erp_ultimate_final'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

const sourceFiles = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server', 'src'))];

const sourceOnly = process.argv.includes('--source-only');
if (!sourceOnly && !exists('package-lock.json')) failures.push('Root package-lock.json is missing; run install-all.bat once on a clean checkout before release certification.');
if (!exists('server/package-lock.json')) failures.push('server/package-lock.json is missing.');

const serverPkg = JSON.parse(read('server/package.json'));
if (serverPkg.scripts?.typecheck !== 'tsc --noEmit') failures.push('server/package.json must expose a deterministic typecheck script.');

const auth = read('server/src/middleware/auth.ts');
if (!auth.includes('export function requirePermission')) failures.push('Canonical requirePermission middleware is missing.');
if (auth.includes('export function hasRole')) failures.push('hasRole must remain centralized in RBAC service, not auth middleware.');

const permissions = read('server/src/core/rbac/permission-catalog.ts');
if (/code:\s*'counselor'[\s\S]{0,600}'Lead\.Convert'/.test(permissions)) failures.push('Counselor must not receive Lead.Convert permission.');

for (const file of ['server/src/tests/p1-scope-hardening.test.ts','server/src/tests/rbac-scope.test.ts']) {
  if (exists(file) && read(file).includes('afterAll(() => //')) failures.push(`Malformed afterAll callback remains in ${file}.`);
}

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  for (const d of sf.parseDiagnostics ?? []) {
    const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    failures.push(`Syntax error ${path.relative(root, file)}:${lc.line + 1}:${lc.character + 1} — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
}

// Detect imports from auth middleware that ask for symbols not exported there.
if (sourceFiles.length) {
  const middlewareExports = new Set(['authenticate','hasLegacyRole','hasAnyLegacyRole','authorize','requirePermission','canAccessBranchResource','resolveBranchScope']);
  for (const file of sourceFiles) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    sf.forEachChild(node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== '../middleware/auth.js') return;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      for (const el of bindings.elements) {
        const name = el.propertyName?.text ?? el.name.text;
        if (!middlewareExports.has(name)) failures.push(`Invalid auth middleware import '${name}' in ${path.relative(root, file)}.`);
      }
    });
  }
}

// Runtime state is intentionally created during local installation/startup.
// This source-tree audit therefore does not reject local node_modules, dist,
// SQLite data, or .env files. Instead, verify that release hygiene explicitly
// excludes them from source/release preparation.
if (!sourceOnly) {
  const gitignore = exists('.gitignore') ? read('.gitignore') : '';
  const cleanScript = exists('scripts/prepare-clean-release.ps1') ? read('scripts/prepare-clean-release.ps1') : '';
  for (const required of ['node_modules', 'dist', 'server/data', 'server/.env', '.env']) {
    if (!gitignore.includes(required)) failures.push(`.gitignore must exclude ${required}.`);
    if (!cleanScript.includes(required)) failures.push(`Clean-release preparation must remove ${required}.`);
  }
}

// The event bus must preserve required-handler failure semantics.
const eventBus = read('server/src/core/events/event-bus.ts');
for (const required of ['handlersReady', 'hasRequiredFailure', 'handlersToRun.sort']) {
  if (!eventBus.includes(required)) failures.push(`Event bus hardening marker missing: ${required}.`);
}

if (failures.length) {
  console.error('HIGH-ASSURANCE STATIC AUDIT: FAIL');
  for (const f of failures) console.error(` - ${f}`);
  if (warnings.length) {
    console.error('Warnings:');
    for (const w of warnings) console.error(` - ${w}`);
  }
  process.exit(1);
}

console.log('HIGH-ASSURANCE STATIC AUDIT: PASS');
if (warnings.length) {
  console.log('Warnings:');
  for (const w of warnings) console.log(` - ${w}`);
}
