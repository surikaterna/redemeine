import { describe, expect, test } from '@jest/globals';
import { EntityArray } from '../src/types';

describe('EntityArray', () => {
  test('upsert inserts then updates by id', () => {
    const arr: Array<{ id: string; qty: number }> = [];

    EntityArray.upsert(arr, { id: 'a', qty: 1 });
    EntityArray.upsert(arr, { id: 'a', qty: 5 });

    expect(arr).toEqual([{ id: 'a', qty: 5 }]);
  });

  test('update patches existing entity and ignores missing id', () => {
    const arr: Array<{ id: string; qty: number; title?: string }> = [{ id: 'a', qty: 1 }];

    EntityArray.update(arr, 'a', { qty: 2, title: 'ok' });
    EntityArray.update(arr, 'missing', { qty: 9 });

    expect(arr).toEqual([{ id: 'a', qty: 2, title: 'ok' }]);
  });

  test('remove deletes matching entity and ignores missing id', () => {
    const arr: Array<{ id: string; qty: number }> = [
      { id: 'a', qty: 1 },
      { id: 'b', qty: 2 }
    ];

    EntityArray.remove(arr, 'a');
    EntityArray.remove(arr, 'missing');

    expect(arr).toEqual([{ id: 'b', qty: 2 }]);
  });
});
