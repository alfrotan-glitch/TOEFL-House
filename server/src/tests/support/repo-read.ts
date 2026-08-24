import fs from 'node:fs';
import path from 'node:path';

export const repoRoot = path.basename(process.cwd()) === 'server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());

export function readRepo(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}
