#!/usr/bin/env node
/**
 * SERVER DEPENDENCY ISOLATION AUDIT — Master Engineering Protocol §45, LAW 9
 * ============================================================================
 * Every bare module the server's test graph imports must be declared by
 * `server/package.json`.
 *
 * WHY THIS EXISTS
 *
 * CI runs the backend job with ONLY the server package installed
 * (`working-directory: server`, `npm ci`). The repository root is never
 * installed there. Locally the opposite is true: a root install is always
 * present, and Node resolution walks up from any file into it.
 *
 * So a server test could import `react` — directly, or transitively through a
 * frontend module under ../src — and every local command would pass while the
 * backend CI job failed with "Cannot find module 'react'". That is exactly what
 * happened: the job was red while `npm run release:validate` reported 21/21,
 * because the gate cannot reproduce CI's dependency isolation by running in an
 * environment that has everything.
 *
 * Reinstalling the sandbox to imitate CI on every gate run would be slow and
 * fragile. Reading the import graph is neither, and it fails for the same
 * reason CI would.
 *
 * WHAT IT DOES NOT CHECK
 *
 * Version compatibility, and anything reached by a dynamic `import()` with a
 * computed specifier. It answers one question — "is this package declared where
 * it is used?" — and nothing else.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const serverRoot = path.join(repoRoot, 'server');

const serverPkg = JSON.parse(readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(serverPkg.dependencies ?? {}),
  ...Object.keys(serverPkg.devDependencies ?? {}),
]);

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** The package a bare specifier belongs to ('react-dom/client' -> 'react-dom'). */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Anchored to the start of a line, and the clause between the keyword and
// `from` may only contain identifier punctuation. An earlier version used
// `[\s\S]*?`, which happily ran from the word "from" inside a template literal
// to the next quote and reported `${budgetLine.name}` as a missing package.
const IMPORT_RE =
  /^[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?[\w*{}\s,$]*?from[ \t]*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_RE = /^[ \t]*import[ \t]*['"]([^'"]+)['"]/gm;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const found = new Set();
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return [...found];
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolves a relative import to a real file, tolerating the .js/.ts swap. */
function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find(isFile) ?? null;
}

// Every server source and test file is an entry point: the CI job type-checks
// and runs all of them.
const entries = execSync("git ls-files 'server/src/**/*.ts'", {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((f) => path.join(repoRoot, f));

const visited = new Set();
const undeclared = new Map(); // package -> Set of importing files

function walk(file) {
  if (visited.has(file)) return;
  visited.add(file);
  for (const specifier of importsOf(file)) {
    if (specifier.startsWith('.')) {
      const next = resolveRelative(file, specifier);
      // An unresolvable relative import is the type-checker's problem, not
      // this audit's; staying silent keeps one failure in one place.
      if (next) walk(next);
      continue;
    }
    if (builtins.has(specifier)) continue;
    // Not a module specifier at all (an interpolation or prose that slipped
    // through); the type-checker owns real syntax errors.
    if (/[\s$`]/.test(specifier)) continue;
    const pkg = packageOf(specifier);
    if (declared.has(pkg)) continue;
    if (!undeclared.has(pkg)) undeclared.set(pkg, new Set());
    undeclared.get(pkg).add(path.relative(repoRoot, file));
  }
}

for (const entry of entries) walk(entry);

if (undeclared.size > 0) {
  console.error('SERVER DEPENDENCY ISOLATION AUDIT: FAIL\n');
  console.error(
    `${undeclared.size} package(s) are imported by the server graph but not declared in server/package.json:\n`,
  );
  for (const [pkg, files] of [...undeclared].sort()) {
    console.error(`  ${pkg}`);
    for (const f of [...files].sort().slice(0, 5)) console.error(`      imported by ${f}`);
    if (files.size > 5) console.error(`      …and ${files.size - 5} more`);
  }
  console.error(
    '\nThe backend CI job installs ONLY server/. A package that resolves here through',
  );
  console.error(
    'the repository root install will not resolve there. Declare it in',
  );
  console.error(
    'server/package.json (and map it in tsconfig.test.json / vitest.config.ts if the',
  );
  console.error('importing file lives outside server/).');
  process.exit(1);
}

console.log(
  `SERVER DEPENDENCY ISOLATION AUDIT: PASS (${visited.size} files in the server import graph, ${declared.size} declared packages)`,
);
