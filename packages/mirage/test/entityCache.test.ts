import { findEntityInCollection } from '../src/proxy/entityCache';
import type { InvocationContext } from '../src/types/core';

describe('entityCache', () => {
    const makeCollection = () => [
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' },
        { id: 'c', name: 'Charlie' }
    ];

    const idSelection = (id: string): InvocationContext => ({
        idsPayload: { id },
        packPrefix: [],
        entityPk: undefined
    });

    const pkSelection = (pk: Record<string, unknown>): InvocationContext => ({
        entityPk: pk,
        idsPayload: {},
        packPrefix: []
    });

    test('finds entity by id', () => {
        const col = makeCollection();
        const result = findEntityInCollection(col, idSelection('b'), 1);
        expect(result).toEqual({ id: 'b', name: 'Bob' });
    });

    test('returns undefined for non-existent id', () => {
        const col = makeCollection();
        const result = findEntityInCollection(col, idSelection('z'), 1);
        expect(result).toBeUndefined();
    });

    test('cache returns same result for same version', () => {
        const col = makeCollection();
        const r1 = findEntityInCollection(col, idSelection('a'), 10);
        const r2 = findEntityInCollection(col, idSelection('a'), 10);
        expect(r1).toBe(r2);
    });

    test('cache invalidates when version changes', () => {
        const col = [{ id: 'x', val: 1 }];
        findEntityInCollection(col, idSelection('x'), 20);

        // Mutate collection to simulate state change
        const col2 = [{ id: 'x', val: 2 }];
        const result = findEntityInCollection(col2, idSelection('x'), 21);
        expect(result).toEqual({ id: 'x', val: 2 });
    });

    test('composite pk lookup works', () => {
        const col = [
            { country: 'US', label: 'home', street: '123 Main' },
            { country: 'UK', label: 'work', street: '456 High' }
        ];
        const result = findEntityInCollection(col, pkSelection({ country: 'UK', label: 'work' }), 30);
        expect(result).toEqual({ country: 'UK', label: 'work', street: '456 High' });
    });

    test('composite pk returns undefined for non-match', () => {
        const col = [{ country: 'US', label: 'home', street: '123 Main' }];
        const result = findEntityInCollection(col, pkSelection({ country: 'DE', label: 'home' }), 31);
        expect(result).toBeUndefined();
    });
});
