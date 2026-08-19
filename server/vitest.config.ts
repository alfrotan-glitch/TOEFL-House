import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverRoot, '..');

export default defineConfig({
  test: {
    setupFiles: ['./src/tests/setup.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    fileParallelism: false,
    include: ['src/tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // `fee-bill-render.test.ts` imports the SHARED frontend modules
    // (src/utils/feeBillTemplate, src/config/branding, src/types) so the
    // printed document is tested as the real thing rather than a copy. Those
    // files live ABOVE this vitest root.
    //
    // Vite only transforms files it is allowed to serve. Outside the root and
    // without this allow-list the file can be handed to Node untransformed —
    // Node then meets TypeScript syntax and throws a bare
    // "SyntaxError: Invalid or unexpected token" with no file or line, which is
    // exactly the reported failure. It reproduces on Windows (drive-letter
    // path normalisation makes the out-of-root check reject these paths) while
    // passing on Linux, which is why the same commit behaved differently on
    // the two machines.
    //
    // Declaring the repository root keeps the shared-module import working on
    // every platform.
    server: {
      deps: {
        // Ensure the shared frontend sources are processed by Vite (inlined)
        // rather than being resolved as external CommonJS by Node.
        inline: [/[\\/]src[\\/](utils|config|types)[\\/]/],
      },
    },
  },
  server: {
    fs: {
      allow: [repoRoot, serverRoot],
    },
  },
});