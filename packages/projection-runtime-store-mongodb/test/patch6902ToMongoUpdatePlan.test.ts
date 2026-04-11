import { describe, expect, test } from 'bun:test';
import { patch6902ToMongoUpdatePlan } from '../src/patch6902ToMongoUpdatePlan';

describe('patch6902ToMongoUpdatePlan', () => {
  test('compiles common scalar/object operations to mongo set/unset/test guards', () => {
    const fullDocument = {
      nested: { keep: false },
      status: 'open',
      total: 3
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'test', path: '/nested/keep', value: true },
        { op: 'replace', path: '/nested/keep', value: false },
        { op: 'remove', path: '/obsolete' },
        { op: 'add', path: '/status', value: 'open' }
      ],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'compiled',
      set: {
        'nested.keep': false,
        status: 'open'
      },
      unset: ['obsolete'],
      testGuards: [{ path: 'nested.keep', value: true }]
    });
  });

  test('compiles array-path operations by setting parent container from fullDocument', () => {
    const fullDocument = {
      lines: ['a', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'remove', path: '/lines/1' },
        { op: 'add', path: '/lines/1', value: 'c' }
      ],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'compiled',
      set: { lines: ['a', 'c'] },
      unset: [],
      testGuards: []
    });
  });

  test('falls back to full document when mongo path is unsafe', () => {
    const fullDocument = {
      'a.b': 1
    };

    const plan = patch6902ToMongoUpdatePlan(
      [{ op: 'add', path: '/a.b', value: 1 }],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'fallback-full-document',
      fullDocument
    });
  });
});
