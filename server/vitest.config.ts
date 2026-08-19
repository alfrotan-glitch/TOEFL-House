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
