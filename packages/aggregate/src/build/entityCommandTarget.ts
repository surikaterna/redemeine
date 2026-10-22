import type { EntityCommandTarget, EntityCommandTargets, MountedStructureMetadata } from '../types/entityMount';
import { singular, toCamelCase, toSnakeCase } from '../naming';

// Provenance belongs to a definition-map registration, never a reusable handler or grouped mount.
const targetsByDefinitions = new WeakMap<object, EntityCommandTargets>();

export function definitionTargets(definitions: object): EntityCommandTargets {
    let targets = targetsByDefinitions.get(definitions);
    if (!targets) {
        targets = {};
        targetsByDefinitions.set(definitions, targets);
    }
    return targets;
}

// Copy the winning definition and its registration together; an ordinary root replaces any old target.
export function mergeDefinitions<T>(destination: Record<string, T>, source: Record<string, T>): Record<string, T> {
    const targets = definitionTargets(destination);
    const incoming = definitionTargets(source);
    for (const key of Object.keys(source)) {
        destination[key] = source[key]!;
        targets[key] = incoming[key] ?? [];
    }
    return destination;
}

export function commandTarget(mount: MountedStructureMetadata): EntityCommandTarget {
    const { kind, statePath, pk, commandPrefix } = mount;
    return { kind, statePath: [...statePath], pk, commandPrefix };
}

function invalidTarget(): never {
    throw new Error('Invalid mounted command target');
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidTarget();
    return value as Record<string, unknown>;
}

// String equivalence preserves existing numeric/string identity matching on mounted events.
function equal(left: unknown, right: unknown): boolean {
    const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
    return scalar(left) && scalar(right) && String(left) === String(right);
}

function identityFields(target: EntityCommandTarget, field: string): string[] {
    const name = target.commandPrefix;
    const names = new Set([name, singular(name), toCamelCase(name), singular(toCamelCase(name)), toSnakeCase(name), singular(toSnakeCase(name))]);
    const suffix = field.charAt(0).toUpperCase() + field.slice(1);
    return [...names].map(prefix => prefix + suffix).concat(field);
}

function identity(target: EntityCommandTarget, payload: Record<string, unknown>, used: Set<string>, leaf: boolean): Record<string, unknown> {
    const fields = target.kind === 'map' ? ['key'] : typeof target.pk === 'string' ? [target.pk] : target.pk ?? ['id'];
    if (!fields.length) return invalidTarget();
    const composite = target.kind === 'list' && payload.__entityPk !== undefined ? record(payload.__entityPk) : undefined;
    const result: Record<string, unknown> = {};
    for (const field of fields) {
        const aliases = identityFields(target, field);
        if (target.kind === 'list' && fields.length === 1 && field !== 'id') aliases.push(...identityFields(target, 'id'));
        const keys = [...new Set(aliases)].filter(key => Object.hasOwn(payload, key) && (leaf || (key !== 'id' && key !== 'key')));
        const values = keys.map(key => payload[key]);
        if (composite && Object.hasOwn(composite, field)) {
            keys.push(`__entityPk.${field}`);
            values.push(composite[field]);
        }
        if (!values.length || values.some(value => !equal(value, values[0])) || keys.some(key => used.has(key))) invalidTarget();
        keys.forEach(key => used.add(key));
        result[field] = values[0];
    }
    return result;
}

function select(container: unknown, target: EntityCommandTarget, values: Record<string, unknown>): unknown {
    if (target.kind === 'map') {
        const entries = record(container);
        const key = String(values.key);
        if (!Object.hasOwn(entries, key)) return invalidTarget();
        return record(entries[key]);
    }
    if (!Array.isArray(container)) return invalidTarget();
    const matches = container.filter(item => Object.entries(values).every(([key, value]) => equal(record(item)[key], value)));
    if (matches.length !== 1) return invalidTarget();
    return record(matches[0]);
}

export function selectedCommandState(state: unknown, payload: unknown, chain: readonly EntityCommandTarget[]): unknown {
    const used = new Set<string>();
    let selected = state;
    for (const [index, target] of chain.entries()) {
        const values = identity(target, record(payload), used, index === chain.length - 1);
        const container = target.statePath.reduce<unknown>((parent, key) => {
            const current = record(parent);
            return Object.hasOwn(current, key) ? current[key] : invalidTarget();
        }, selected);
        selected = select(container, target, values);
    }
    return selected;
}
