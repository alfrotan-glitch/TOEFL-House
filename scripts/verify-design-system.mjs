/**
 * Design-system audit.
 *
 * A design system that is merely *available* gets bypassed. This makes two of
 * its properties mechanical, so the build fails rather than the interface
 * quietly drifting:
 *
 *   1. DIRECTION IS LOGICAL. Application code may not use physical direction
 *      utilities (`ml-`, `pr-`, `text-left`, `left-`, `border-r`, …). They
 *      hard-code a left-to-right reading order, which is exactly what has to
 *      be avoided for Persian/Dari — RTL must be a first-class layout mode,
 *      not a set of overrides. The logical equivalents (`ms-`, `pe-`,
 *      `text-start`, `start-`, `border-e`) mirror automatically.
 *
 *   2. DIRECTION HAS ONE AUTHORITY. No component may pin `dir` itself. The
 *      DirectionProvider sets it once on <html> so portalled content — modals,
 *      dropdowns, toasts — inherits it. A view that pins its own direction is
 *      how a dialog ends up LTR inside an RTL page.
 *
 * Run: npm run audit:design-system
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const SRC = path.join(root, 'src');
const DESIGN_SYSTEM = path.join(SRC, 'design-system');

/** Physical utilities and the logical utility that replaces each. */
const DIRECTIONAL = [
  [/(?<![\w-])ml-([\w./[\]%-]+)/g, 'ms-$1'],
  [/(?<![\w-])mr-([\w./[\]%-]+)/g, 'me-$1'],
  [/(?<![\w-])pl-([\w./[\]%-]+)/g, 'ps-$1'],
  [/(?<![\w-])pr-([\w./[\]%-]+)/g, 'pe-$1'],
  [/(?<![\w-])text-left(?![\w-])/g, 'text-start'],
  [/(?<![\w-])text-right(?![\w-])/g, 'text-end'],
  [/(?<![\w-])border-l(?![\w-])/g, 'border-s'],
  [/(?<![\w-])border-r(?![\w-])/g, 'border-e'],
  [/(?<![\w-])rounded-l(?![\w-])/g, 'rounded-s'],
  [/(?<![\w-])rounded-r(?![\w-])/g, 'rounded-e'],
  [/(?<![\w-])left-([\w./[\]%-]+)/g, 'start-$1'],
  [/(?<![\w-])right-([\w./[\]%-]+)/g, 'end-$1'],
];

/**
 * Places a physical direction is legitimate.
 *
 * `index.css` may define direction-specific rules deliberately, and the print
 * stylesheet targets paper rather than the app shell.
 */
const EXEMPT_FILES = new Set([path.join(SRC, 'index.css')]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Class names only appear inside strings; ignore prose in comments. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const failures = [];
const files = sourceFiles(SRC);

for (const file of files) {
  if (EXEMPT_FILES.has(file)) continue;
  const rel = path.relative(root, file);
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripComments(raw);

  for (const [pattern, replacement] of DIRECTIONAL) {
    pattern.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      const line = text.slice(0, m.index).split('\n').length;
      failures.push(
        `${rel}:${line} uses "${m[0]}" — a physical direction. ` +
          `Use "${replacement.replace('$1', m[1] ?? '')}" so the layout mirrors in RTL.`,
      );
    }
  }

  // Printing goes through the print authority — with no exemptions.
  //
  // A component that calls window.open and writes its own <style> produces a
  // document with no @page, no repeated table headers, no page numbers and
  // hard-coded physical alignment. One shell fixes all of that at once, and
  // only stays fixed if nothing bypasses it.
  //
  // This check carried a named exemption list while three bespoke documents —
  // the ID card, the registration receipt and the salary slip — were still
  // being migrated. All three now build through the authority, so the list is
  // gone rather than left empty: an empty exemption list is an invitation.
  // A document that genuinely needs different paper asks for it by name
  // (`paper: 'receipt80' | 'card'`), which keeps paper the shell's decision.
  if (!file.startsWith(DESIGN_SYSTEM)) {
    const printWindow = /window\.open\s*\(\s*['"`]{2}|window\.open\s*\(\s*['"`]\s*['"`]/g;
    let pm;
    while ((pm = printWindow.exec(text)) !== null) {
      const line = text.slice(0, pm.index).split('\n').length;
      failures.push(
        `${rel}:${line} opens a blank window to print. Use openPrintDocument() from ` +
          `src/design-system/print.ts so the document gets @page margins, repeated ` +
          `table headers, page numbers and logical alignment.`,
      );
    }
  }

  // Only the direction authority may PIN a direction.
  //
  // Two things are deliberately allowed:
  //   dir="auto"  — defers to the content, which is what mixed Latin/Persian
  //                 user text needs. That is the opposite of pinning.
  //   standalone documents — a printed certificate or fee bill is its own
  //                 HTML document with its own <html dir>, not part of the
  //                 app shell, and it is already language-aware.
  const isStandaloneDocument = /<!DOCTYPE html>/i.test(raw);
  if (!file.startsWith(DESIGN_SYSTEM) && !isStandaloneDocument) {
    const dirAttr = /\bdir\s*=\s*(?:"([^"]*)"|'([^']*)'|\{)/g;
    let m;
    while ((m = dirAttr.exec(text)) !== null) {
      const value = m[1] ?? m[2];
      if (value === 'auto') continue;
      const line = text.slice(0, m.index).split('\n').length;
      failures.push(
        `${rel}:${line} pins \`dir\` itself. Direction is owned by ` +
          `src/design-system/direction.tsx and inherited from <html>; ` +
          `use dir="auto" only for user-entered text of unknown script.`,
      );
    }
  }
}

if (failures.length) {
  console.log('DESIGN SYSTEM AUDIT: FAIL');
  for (const f of failures.slice(0, 40)) console.log(' -', f);
  if (failures.length > 40) console.log(`   …and ${failures.length - 40} more`);
  process.exit(1);
}

console.log(`DESIGN SYSTEM AUDIT: PASS (${files.length} files, direction is logical and single-authority)`);
