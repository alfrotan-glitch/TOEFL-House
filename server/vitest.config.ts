import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverRoot, '..');

export default defineConfig({
  // Vite's root is the REPOSITORY, not server/.
  //
  // `fee-bill-render.test.ts` imports the shared frontend modules
  // (src/utils/feeBillTemplate, src/config/branding, src/types) so the printed
  // document is asserted against the real production builder rather than a
  // copy. Those files live above server/, and Vite refuses to transform files
  // outside its root: on Windows the drive-letter form of those paths made the
  // out-of-root check reject them, the file was handed to Node untransformed,
  // and Node threw a bare "SyntaxError: Invalid or unexpected token" with no
  // file and no line (visible as `import 0ms` in the run summary).
  //
  // Widening the root removes the out-of-root condition itself instead of
  // working around it with allow-lists, so it behaves identically on Windows,
  // Linux and CI.
  root: repoRoot,
  // React resolves from THIS package, for the same reason the type-check maps
  // it (see tsconfig.test.json).
  //
  // Frontend modules under ../src import React, and module resolution walks up
  // from THEIR directory — never into server/node_modules. The backend CI job
  // installs only this package, so those imports failed there while passing
  // locally, where a root install happened to satisfy them. Three suites load
  // frontend code that reaches React: the print authority (via its direction
  // context), the fee-bill renderer, and the cross-view freshness test.
  //
  // Exact-match patterns, because a bare string alias for 'react' also matches
  // 'react-dom' by prefix and would silently mis-resolve it.
  resolve: {
    alias: [
      { find: /^react$/, replacement: path.join(serverRoot, 'node_modules', 'react', 'index.js') },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(serverRoot, 'node_modules', 'react', 'jsx-runtime.js'),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(serverRoot, 'node_modules', 'react-dom', 'index.js'),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(serverRoot, 'node_modules', 'react-dom', 'client.js'),
      },
    ],
  },
  test: {
    setupFiles: [path.join(serverRoot, 'src', 'tests', 'setup.ts')],
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    fileParallelism: false,
    include: ['server/src/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
