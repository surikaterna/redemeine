import type { EntityCommandTarget, EntityCommandTargets, MountedStructureMetadata, ResolvedCommandTargets } from '../types/entityMount';
import { primaryKey } from './primaryKey';

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

// Expose final local-name provenance without sharing dispatch-owned or caller-owned arrays.
export function resolvedCommandTargets(definitions: Record<string, unknown>): ResolvedCommandTargets {
    const targets = definitionTargets(definitions);
    return Object.freeze(Object.fromEntries(Object.keys(definitions).map(key => [key,
        snapshotTargetChain(targets[key] ?? [])
    ])));
}

// Freeze only dispatch-owned copies, never caller configuration or reusable functions.
export function snapshotTargetChain(chain: readonly EntityCommandTarget[]): readonly EntityCommandTarget[] {
    validateIdentityLayout(chain);
    return Object.freeze(chain.map(target => Object.freeze({
        ...target,
        statePath: Object.freeze([...target.statePath]),
        pk: typeof target.pk === 'string' || target.pk === undefined ? target.pk : Object.freeze([...target.pk])
    })));
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

function primaryKeyFields(target: EntityCommandTarget): readonly string[] {
    const pk = target.kind === 'map' ? 'key' : primaryKey(target.pk);
    return typeof pk === 'string' ? [pk] : pk;
}

function payloadField(target: EntityCommandTarget, field: string, leaf: boolean): string {
    return leaf ? field : target.commandPrefix + field.charAt(0).toUpperCase() + field.slice(1);
}

function validateIdentityLayout(chain: readonly EntityCommandTarget[]): void {
    const used = new Set<string>();
    for (const [index, target] of chain.entries()) {
        const fields = primaryKeyFields(target);
        if (!fields.length || new Set(fields).size !== fields.length) invalidTarget();
        for (const field of fields) {
            const key = payloadField(target, field, index === chain.length - 1);
            if (used.has(key)) invalidTarget();
            used.add(key);
        }
    }
}

function identity(target: EntityCommandTarget, payload: Record<string, unknown>, leaf: boolean): Record<string, unknown> {
    return Object.fromEntries(primaryKeyFields(target).map(field => {
        const key = payloadField(target, field, leaf);
        if (!Object.hasOwn(payload, key) || !equal(payload[key], payload[key])) invalidTarget();
        return [field, payload[key]];
    }));
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
    let selected = state;
    for (const [index, target] of chain.entries()) {
        const values = identity(target, record(payload), index === chain.length - 1);
        const container = target.statePath.reduce<unknown>((parent, key) => {
            const current = record(parent);
            return Object.hasOwn(current, key) ? current[key] : invalidTarget();
        }, selected);
        selected = select(container, target, values);
    }
    return selected;
}
