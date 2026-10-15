import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type SchemaMode = 'zod-first' | 'types-first';
export interface SchemaPolicy { mode: SchemaMode; maxDepth: number }
export const defaultSchemaPolicy: SchemaPolicy = { mode: 'zod-first', maxDepth: 60 };

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

export function validateSchemaPolicy(value: unknown, label = 'redemeine.schemas'): SchemaPolicy {
    if (value === undefined) return { ...defaultSchemaPolicy };
    const options = record(value, label);
    for (const key of Object.keys(options)) if (!['mode', 'maxDepth'].includes(key)) throw new Error(`${label}: unknown option ${key}`);
    const mode = options.mode === undefined ? defaultSchemaPolicy.mode : options.mode;
    const maxDepth = options.maxDepth === undefined ? defaultSchemaPolicy.maxDepth : options.maxDepth;
    if (mode !== 'zod-first' && mode !== 'types-first') throw new Error(`${label}.mode must be zod-first or types-first`);
    if (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) {
        throw new Error(`${label}.maxDepth must be an integer from 1 to 256`);
    }
    return { mode, maxDepth };
}

/** The closest owning package wins, including when commands run from a monorepo root. */
export function schemaPolicyForEntry(entry: string): SchemaPolicy {
    let directory = dirname(resolve(entry));
    while (true) {
        const file = join(directory, 'package.json');
        if (existsSync(file)) {
            const manifest = record(JSON.parse(readFileSync(file, 'utf8')), file);
            const config = manifest.redemeine === undefined ? {} : record(manifest.redemeine, `${file}: redemeine`);
            return validateSchemaPolicy(config.schemas, `${file}: redemeine.schemas`);
        }
        const parent = dirname(directory);
        if (parent === directory) return { ...defaultSchemaPolicy };
        directory = parent;
    }
}
