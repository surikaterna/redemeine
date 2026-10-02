import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safePath } from './paths';

export type NewFile = { path: string; content: string };

export function writePlan(root: string, files: readonly NewFile[], directories: readonly string[] = []): void {
  for (const file of files) {
    safePath(root, file.path);
    if (existsSync(file.path)) throw new Error(`Refusing to overwrite: ${file.path}`);
  }
  for (const directory of directories) safePath(root, directory);
  for (const directory of directories) mkdirSync(directory, { recursive: true });
  for (const file of files) {
    safePath(root, file.path);
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, { flag: 'wx' });
  }
}
