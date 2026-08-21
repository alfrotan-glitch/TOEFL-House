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
// The invariant is that the server typechecks with no emit — not that the
// script is one exact string. It was `!== 'tsc --noEmit'`, which failed the
// moment a SECOND, stricter check was added (the test tsconfig, which covers
// src/tests after they were excluded from the build config). An invariant that
// breaks when the thing it guards gets stronger is testing the wrong property.
const serverTypecheck = serverPkg.scripts?.typecheck ?? '';
if (!/\btsc\b/.test(serverTypecheck) || !serverTypecheck.includes('--noEmit')) {
  failures.push('server/package.json must expose a deterministic typecheck script running tsc --noEmit.');
}

const auth = read('server/src/middleware/auth.ts');
if (!auth.includes('export function requirePermission')) failures.push('Canonical requirePermission middleware is missing.');
if (auth.includes('export function hasRole')) failures.push('hasRole must remain centralized in RBAC service, not auth middleware.');

const permissions = read('server/src/core/rbac/permission-catalog.ts');
if (/code:\s*'counselor'[\s\S]{0,600}'Lead\.Convert'/.test(permissions)) failures.push('Counselor must not receive Lead.Convert permission.');

for (const file of [
  'server/src/tests/work-packages/wp02/p1-scope-hardening.test.ts',
  'server/src/tests/work-packages/wp02/rbac-scope.test.ts',
]) {
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
// The export list is PARSED FROM THE MIDDLEWARE ITSELF rather than hard-coded:
// a manual list silently rots as the middleware grows and then reports real,
// correctly-exported symbols as failures (which is exactly what happened with
// denyPermissionless/readSessionCookie).
if (sourceFiles.length) {
  const authMiddlewarePath = path.join(root, 'server/src/middleware/auth.ts');
  const middlewareExports = new Set();
  if (fs.existsSync(authMiddlewarePath)) {
    const authSf = ts.createSourceFile(authMiddlewarePath, fs.readFileSync(authMiddlewarePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    authSf.forEachChild((node) => {
      const isExported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) return;
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        middlewareExports.add(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) middlewareExports.add(decl.name.text);
        }
      } else if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        middlewareExports.add(node.name.text);
      }
    });
  }
  if (!middlewareExports.size) failures.push('Could not parse any exports from server/src/middleware/auth.ts.');
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
  for (const required of ['node_modules', 'dist', 'server/data', 'server/.env', '.env']) {
    if (!gitignore.includes(required)) failures.push(`.gitignore must exclude ${required}.`);
  }
  // Release hygiene is now asserted against the real repository state by
  // scripts/release-validate.mjs ("no build output or secrets tracked"), which
  // reads `git ls-files`. The previous check grepped a PowerShell script for
  // path strings — it passed whether or not that script could run, and the
  // script exited 127 on any non-Windows machine, so CI would have reported a
  // release step that never executed as successful.
  if (!exists('scripts/release-validate.mjs')) {
    failures.push('scripts/release-validate.mjs (portable release gate) is missing.');
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
