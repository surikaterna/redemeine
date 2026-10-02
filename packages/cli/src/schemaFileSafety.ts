import { existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function validateSchemaFilename(name: string): void {
    const hasControl = [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
    if (!name || name === '.' || name === '..' || /[/\\:]/u.test(name) || hasControl) {
        throw new Error(`Unsafe schema filename: ${JSON.stringify(name)}`);
    }
}

export function validateSchemaPaths(paths: readonly string[]): void {
    const seen = new Set<string>();
    for (const path of paths) {
        const absolute = resolve(path);
        if (seen.has(absolute)) throw new Error(`Duplicate schema output: ${path}`);
        seen.add(absolute);
        rejectSymlinks(absolute);
    }
}

function rejectSymlinks(path: string): void {
    let current = path;
    while (true) {
        // lstat also detects dangling aliases, which existsSync alone misses.
        try {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink()) throw new Error(`Symlink schema output: ${current}`);
            if (current === path && (!stat.isFile() || stat.nlink > 1)) throw new Error(`Unsafe existing schema output: ${current}`);
        } catch (error) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (existsSync(current) && current !== path && !lstatSync(current).isDirectory()) {
            throw new Error(`Schema output parent is not a directory: ${current}`);
        }
        const parent = dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

export function schemaSource(value: unknown): string {
    // JSON object syntax treats __proto__ specially; computed keys preserve data semantics.
    return JSON.stringify(value, null, 2).replace(/^(\s*)"__proto__":/gm, '$1["__proto__"]:');
}
