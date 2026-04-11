import { describe, expect, test } from 'bun:test';
import { patch6902ToMongoUpdatePlan } from '../src/patch6902ToMongoUpdatePlan';

describe('patch6902ToMongoUpdatePlan', () => {
  test('scenario: deep object full replacement compiles as parent set', () => {
    const fullDocument = {
      profile: { name: 'Ada', address: { city: 'Stockholm', zip: '11122' } }
    };

    const plan = patch6902ToMongoUpdatePlan(
      [{ op: 'replace', path: '/profile', value: fullDocument.profile }],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { profile: fullDocument.profile },
      unset: [],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('scenario: deep object partial replacement compiles as leaf set', () => {
    const fullDocument = {
      profile: { name: 'Ada', address: { city: 'Gothenburg', zip: '41110' } }
    };

    const plan = patch6902ToMongoUpdatePlan(
      [{ op: 'replace', path: '/profile/address/city', value: 'Gothenburg' }],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { 'profile.address.city': 'Gothenburg' },
      unset: [],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('scenario: remove first array element compiles as $pop:-1', () => {
    const fullDocument = {
      lines: ['b', 'c', 'd']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/0' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: {},
      unset: [],
      push: {},
      pop: { lines: -1 },
      testGuards: []
    });
  });

  test('scenario: remove middle element compiles as update pipeline', () => {
    const fullDocument = {
      lines: ['a', 'b', 'd', 'e', 'f']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/2' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-pipeline',
      pipeline: [
        {
          $set: {
            'state.lines': {
              $concatArrays: [
                { $slice: ['$state.lines', 2] },
                {
                  $slice: ['$state.lines', 3, { $subtract: [{ $size: '$state.lines' }, 3] }]
                }
              ]
            }
          }
        }
      ],
      testGuards: []
    });
  });

  test('scenario: remove last array element compiles as $pop:1', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/3' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: {},
      unset: [],
      push: {},
      pop: { lines: 1 },
      testGuards: []
    });
  });

  test('scenario: add nested scalar compiles to leaf set', () => {
    const fullDocument = {
      meta: { status: 'open' }
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/meta/status', value: 'open' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { 'meta.status': 'open' },
      unset: [],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('scenario: remove nested scalar compiles to unset', () => {
    const fullDocument = {
      meta: { keep: true }
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/meta/obsolete' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: {},
      unset: ['meta.obsolete'],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('scenario: test guard plus replace compiles with deterministic filter guard', () => {
    const fullDocument = {
      nested: { keep: false }
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'test', path: '/nested/keep', value: true },
        { op: 'replace', path: '/nested/keep', value: false }
      ],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { 'nested.keep': false },
      unset: [],
      push: {},
      pop: {},
      testGuards: [{ path: 'nested.keep', value: true }]
    });
  });

  test('scenario: copy operation compiles to destination set from full document', () => {
    const fullDocument = {
      total: 7,
      snapshotTotal: 7
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'copy', from: '/total', path: '/snapshotTotal' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { snapshotTotal: 7 },
      unset: [],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('scenario: move operation compiles as unset source and set destination', () => {
    const fullDocument = {
      to: 'value'
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'move', from: '/from', path: '/to' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { to: 'value' },
      unset: ['from'],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('scenario: add array append by dash compiles as $push', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/-', value: 'c' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: {},
      unset: [],
      push: { lines: 'c' },
      pop: {},
      testGuards: []
    });
  });

  test('scenario: indexed append equivalence compiles as $push', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/2', value: 'c' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: {},
      unset: [],
      push: { lines: 'c' },
      pop: {},
      testGuards: []
    });
  });

  test('scenario: indexed replace compiles as direct set', () => {
    const fullDocument = {
      lines: ['a', 'B', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'replace', path: '/lines/1', value: 'B' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled-update-document',
      set: { 'lines.1': 'B' },
      unset: [],
      push: {},
      pop: {},
      testGuards: []
    });
  });

  test('falls back for non-append indexed add into middle of array', () => {
    const fullDocument = {
      lines: ['a', 'x', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/1', value: 'x' }], fullDocument);

    expect(plan).toEqual({
      mode: 'fallback-full-document',
      fullDocument
    });
  });

  test('falls back for mixed middle-remove pipeline and additional ops', () => {
    const fullDocument = {
      lines: ['a', 'c', 'd'],
      status: 'open'
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'remove', path: '/lines/1' },
        { op: 'add', path: '/status', value: 'open' }
      ],
      fullDocument
    );

    expect(plan).toEqual({
      mode: 'fallback-full-document',
      fullDocument
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
