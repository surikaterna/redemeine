import type { InvocationContext } from '../mirage.types';

/**
 * Version-based entity index cache for O(1) entity lookups.
 * Invalidates when core version changes (after event application).
 */
let cachedVersion = -1;
let idIndex = new WeakMap<object, Map<string, number>>();
let compositeIndex = new WeakMap<object, Map<string, number>>();

function invalidateIfStale(version: number): void {
    if (version !== cachedVersion) {
        idIndex = new WeakMap();
        compositeIndex = new WeakMap();
        cachedVersion = version;
    }
}

function getIdIndex(collection: any[], version: number): Map<string, number> {
    invalidateIfStale(version);
    let index = idIndex.get(collection);
    if (index) return index;

    index = new Map<string, number>();
    for (let i = 0; i < collection.length; i++) {
        const entity = collection[i];
        if (entity && typeof entity === 'object' && 'id' in entity) {
            index.set(String(entity.id), i);
        }
    }
    idIndex.set(collection, index);
    return index;
}

function buildCompositeKey(pk: Record<string, unknown>): string {
    return Object.keys(pk).sort().map((k) => `${k}:${pk[k]}`).join('|');
}

function getCompositeIndex(collection: any[], pkKeys: string[], version: number): Map<string, number> {
    invalidateIfStale(version);
    let index = compositeIndex.get(collection);
    if (index) return index;

    index = new Map<string, number>();
    for (let i = 0; i < collection.length; i++) {
        const entity = collection[i];
        if (entity && typeof entity === 'object') {
            const key = pkKeys.sort().map((k) => `${k}:${entity[k]}`).join('|');
            index.set(key, i);
        }
    }
    compositeIndex.set(collection, index);
    return index;
}

/**
 * Find an entity in a collection using cached index lookup (O(1) amortized).
 */
export const findEntityInCollection = (
    collection: any[],
    selection: InvocationContext,
    version: number
): any | undefined => {
    if (selection.entityPk) {
        const keys = Object.keys(selection.entityPk);
        const index = getCompositeIndex(collection, keys, version);
        const lookupKey = buildCompositeKey(selection.entityPk);
        const idx = index.get(lookupKey);
        return idx !== undefined ? collection[idx] : undefined;
    }

    const id = (selection.idsPayload as Record<string, unknown>).id;
    const index = getIdIndex(collection, version);
    const idx = index.get(String(id));
    return idx !== undefined ? collection[idx] : undefined;
};
