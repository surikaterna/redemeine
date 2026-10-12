import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QualificationError } from './plan';
import { record } from './schema';

export async function workspaceRoot(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try { const value: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (record(value).name === 'redemeine') return directory; }
    catch { /* Search only this entrypoint's ancestors, never an arbitrary environment-selected repository. */ }
    directory = dirname(directory);
  }
  throw new QualificationError('workspace_not_found');
}
