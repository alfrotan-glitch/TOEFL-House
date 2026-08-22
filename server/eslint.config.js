// Server lint configuration.
// ============================================================================
// The server package previously had no eslint config and no eslint dependency:
// `npm run lint` only worked because running it from a full checkout let Node
// walk up into the ROOT node_modules and the root eslint.config.js. In CI the
// backend job installs only `server/`, so the same script exited 127 (command
// not found) — the lint gate silently did nothing there.
//
// This mirrors the root config's TypeScript rules for server sources so both
// packages lint identically, and makes `server` self-contained.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'data', 'coverage', 'src/tests/**/*.sqlite*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Node built-ins. Without these, plain `.mjs` scripts report `console`
      // and `process` as undefined — a config gap, not a defect in the scripts.
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
    rules: {
      // The codebase carries a known population of `any` (documented in the
      // audit as outstanding, not introduced here); flagging every one would
      // turn the gate into noise and hide new problems.
      '@typescript-eslint/no-explicit-any': 'off',
      // TR4-R12: unused imports/variables are release-blocking errors, not
      // advisory warnings. A dead import must never enter through a green gate.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
