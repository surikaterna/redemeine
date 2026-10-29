import type { EntityCommandTarget, EntityCommandTargets, MountedStructureMetadata, ResolvedCommandTargets } from '../types/entityMount';
import { primaryKey } from './primaryKey';
import { commandModes } from '../entityCommandLifecycle';

// Provenance belongs to a definition-map registration, never a reusable handler or grouped mount.
const targetsByDefinitions = new WeakMap<object, EntityCommandTargets>();
const namesByDefinitions = new WeakMap<object, Map<string, readonly string[]>>();

// Preserve authored path segments only until compilation, so flattening cannot silently alias names.
export function recordCommandName(destination: Record<string, unknown>, key: string,
    source: object, sourceKey: string, mountName?: string): void {
    const incoming = namesByDefinitions.get(source)?.get(sourceKey) ?? [sourceKey];
    const path = mountName === undefined ? incoming : [mountName, ...incoming];
    const names = namesByDefinitions.get(destination) ?? new Map<string, readonly string[]>();
    const previous = names.get(key) ?? (Object.hasOwn(destination, key) ? [key] : undefined);
    if (previous && JSON.stringify(previous) !== JSON.stringify(path)) {
        throw new Error(`Ambiguous authored commands "${previous.join('.')}" and "${path.join('.')}" compile to "${key}"`);
    }
    names.set(key, path);
    namesByDefinitions.set(destination, names);
}

export function definitionTargets(definitions: object): EntityCommandTargets {
    const existing = targetsByDefinitions.get(definitions);
    if (existing) return existing;
    const targets: EntityCommandTargets = Object.create(null);
    targetsByDefinitions.set(definitions, targets);
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
        recordCommandName(destination, key, source, key);
        Object.defineProperty(destination, key, { value: source[key], enumerable: true, writable: true, configurable: true });
        targets[key] = incoming[key] ?? [];
        commandModes(destination)[key] = commandModes(source)[key] ?? false;
    }
    return destination;
}

export function commandTarget(mount: MountedStructureMetadata, initialState?: object): EntityCommandTarget {
    const { kind, statePath, pk, commandPrefix } = mount;
    return { kind, statePath: [...statePath], pk, commandPrefix, ...(initialState === undefined ? {} : { initialState }) };
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

function select(container: unknown, target: EntityCommandTarget, values: Record<string, unknown>, allowMissing: boolean): string | number | undefined {
    if (target.kind === 'map') {
        const entries = record(container);
        const key = String(values.key);
        if (!Object.hasOwn(entries, key)) return invalidTarget();
        record(entries[key]);
        return key;
    }
    if (!Array.isArray(container)) return invalidTarget();
    const matches = container.flatMap((item, index) => Object.entries(values).every(([key, value]) => equal(record(item)[key], value)) ? [index] : []);
    if (!matches.length && allowMissing) return undefined;
    if (matches.length !== 1) return invalidTarget();
    return matches[0];
}

export function resolveEntityTarget(state: unknown, payload: unknown, chain: readonly EntityCommandTarget[], allowMissing = false) {
    let selected = state;
    const path: (string | number)[] = [];
    for (const [index, target] of chain.entries()) {
        const values = identity(target, record(payload), index === chain.length - 1);
        const container = target.statePath.reduce<unknown>((parent, key) => {
            const current = record(parent);
            path.push(key);
            return Object.hasOwn(current, key) ? current[key] : invalidTarget();
        }, selected);
        const canCreate = allowMissing && index === chain.length - 1 && target.kind === 'list' && target.initialState !== undefined;
        const key = select(container, target, values, canCreate);
        if (key === undefined) return { state: target.initialState, isNew: true, path, identity: values };
        path.push(key);
        selected = (container as Record<string | number, unknown>)[key];
    }
    return { state: selected, isNew: false, path, identity: {} };
}

export function selectedCommandState(state: unknown, payload: unknown, chain: readonly EntityCommandTarget[]): unknown {
    return resolveEntityTarget(state, payload, chain).state;
}
