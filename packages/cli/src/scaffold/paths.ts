import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const reserved = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await abstract as asserts any boolean constructor declare get global infer is keyof module namespace never number object of readonly require set string symbol type undefined unique unknown from async prototype __proto__').split(' '));

export function validName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(value) || reserved.has(value)) {
    throw new Error('Use a non-reserved lowerCamelCase name containing only letters and digits.');
  }
  return value;
}

export function safePath(root: string, ...parts: string[]): string {
  const base = realpathSync(root);
  const target = resolve(base, ...parts);
  const path = relative(base, target);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`Path escapes project: ${target}`);
  let current = base;
  for (const part of path.split(sep)) {
    current = resolve(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink target refused: ${current}`);
    if (current !== target && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
  return target;
}
