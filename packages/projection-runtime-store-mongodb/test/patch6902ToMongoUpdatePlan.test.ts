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

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ profile: fullDocument.profile });
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
    expect(plan.testGuards).toEqual([]);
    expect(plan.exprGuards.length).toBeGreaterThan(0);
    expect(plan.cacheKey).toContain('replace|/profile');
  });

  test('scenario: deep object partial replacement compiles as leaf set', () => {
    const fullDocument = {
      profile: { name: 'Ada', address: { city: 'Gothenburg', zip: '41110' } }
    };

    const plan = patch6902ToMongoUpdatePlan(
      [{ op: 'replace', path: '/profile/address/city', value: 'Gothenburg' }],
      fullDocument
    );

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ 'profile.address.city': 'Gothenburg' });
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
    expect(plan.testGuards).toEqual([]);
  });

  test('scenario: remove first array element compiles as $pop:-1', () => {
    const fullDocument = {
      lines: ['b', 'c', 'd']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/0' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({});
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({ lines: -1 });
  });

  test('scenario: remove middle element compiles as update pipeline', () => {
    const fullDocument = {
      lines: ['a', 'b', 'd', 'e', 'f']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/2' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-pipeline');
    if (plan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }

    expect(plan.pipeline).toEqual([
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
    ]);
    expect(plan.testGuards).toEqual([]);
  });

  test('scenario: remove last array element compiles as $pop:1', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/3' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({});
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({ lines: 1 });
  });

  test('scenario: add nested scalar compiles to leaf set', () => {
    const fullDocument = {
      meta: { status: 'open' }
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/meta/status', value: 'open' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ 'meta.status': 'open' });
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
  });

  test('scenario: remove nested scalar compiles to unset', () => {
    const fullDocument = {
      meta: { keep: true, obsolete: 'old' }
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/meta/obsolete' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({});
    expect(plan.unset).toEqual(['meta.obsolete']);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
  });

  test('scenario: test guard plus replace compiles with strict expr guard', () => {
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

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ 'nested.keep': false });
    expect(plan.testGuards).toEqual([{ path: 'nested.keep', value: true }]);
    expect(plan.exprGuards.length).toBeGreaterThan(0);
  });

  test('scenario: strict missing-vs-null test semantics compile to expr guard', () => {
    const fullDocument = {
      nested: { untouched: 1 }
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'test', path: '/nested/maybe', value: null },
        { op: 'add', path: '/nested/after', value: true }
      ],
      {
        nested: { untouched: 1, after: true }
      }
    );

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.exprGuards.length).toBeGreaterThan(0);
    expect(plan.testGuards).toEqual([{ path: 'nested.maybe', value: null }]);
  });

  test('scenario: copy operation compiles to destination set from full document', () => {
    const fullDocument = {
      total: 7,
      snapshotTotal: 7
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'copy', from: '/total', path: '/snapshotTotal' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ snapshotTotal: 7 });
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
  });

  test('scenario: move operation compiles as unset source and set destination', () => {
    const fullDocument = {
      to: 'value'
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'move', from: '/from', path: '/to' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ to: 'value' });
    expect(plan.unset).toEqual(['from']);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
  });

  test('scenario: add array append by dash compiles as $push', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/-', value: 'c' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({});
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({ lines: 'c' });
    expect(plan.pop).toEqual({});
  });

  test('scenario: indexed append equivalence compiles as $push', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/2', value: 'c' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({});
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({ lines: 'c' });
    expect(plan.pop).toEqual({});
  });

  test('scenario: middle array insert compiles as update pipeline', () => {
    const fullDocument = {
      lines: ['a', 'x', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/1', value: 'x' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-pipeline');
    if (plan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }

    expect(plan.pipeline.length).toBe(1);
  });

  test('scenario: indexed replace compiles as direct set', () => {
    const fullDocument = {
      lines: ['a', 'B', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'replace', path: '/lines/1', value: 'B' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ 'lines.1': 'B' });
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({});
  });

  test('scenario: remove+add reorder on same array compiles as parent array set', () => {
    const fullDocument = {
      lines: ['a', 'c', 'b', 'd']
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'remove', path: '/lines/1' },
        { op: 'add', path: '/lines/2', value: 'b' }
      ],
      fullDocument
    );

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ lines: ['a', 'c', 'b', 'd'] });
  });

  test('scenario: explicit move index on same array compiles as parent array set', () => {
    const fullDocument = {
      lines: ['a', 'c', 'b', 'd']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'move', from: '/lines/1', path: '/lines/2' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ lines: ['a', 'c', 'b', 'd'] });
  });

  test('scenario: combined array-op safe subset compiles as parent set', () => {
    const fullDocument = {
      lines: ['x', 'y', 'z']
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'remove', path: '/lines/0' },
        { op: 'add', path: '/lines/0', value: 'x' }
      ],
      fullDocument
    );

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ lines: ['x', 'y', 'z'] });
  });

  test('scenario: unsafe dotted key uses dynamic field operators pipeline', () => {
    const fullDocument = {
      'a.b': 1
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/a.b', value: 1 }], fullDocument);

    expect(plan.mode).toBe('compiled-update-pipeline');
    if (plan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }

    expect(plan.pipeline[0]?.$set).toBeDefined();
  });

  test('compiles ordered pipeline for unsafe mixed with safe paths', () => {
    const fullDocument = {
      'a.b': 1,
      safe: true
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'add', path: '/a.b', value: 1 },
        { op: 'replace', path: '/safe', value: true }
      ],
      fullDocument
    );

    expect(plan.mode).toBe('compiled-update-pipeline');
    if (plan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }

    const stageSet = (plan.pipeline[0]?.$set as Record<string, unknown>) ?? {};
    expect(stageSet.state).toBeDefined();
  });

  test('compiles deterministic root add as whole-state pipeline set', () => {
    const fullDocument = { total: 1 };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '', value: { total: 1 } }], fullDocument);

    expect(plan.mode).toBe('compiled-update-pipeline');
    if (plan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }

    expect((plan.pipeline[0]?.$set as Record<string, unknown>).state).toEqual(fullDocument);
  });

  test('compiles deterministic root remove/copy/move as whole-state pipeline set', () => {
    const removePlan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '' }], { after: 'ignored' });
    expect(removePlan.mode).toBe('compiled-update-pipeline');
    if (removePlan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }
    expect((removePlan.pipeline[0]?.$set as Record<string, unknown>).state).toBeNull();

    const copyState = { copied: true };
    const copyPlan = patch6902ToMongoUpdatePlan([{ op: 'copy', from: '/from', path: '' }], copyState);
    expect(copyPlan.mode).toBe('compiled-update-pipeline');
    if (copyPlan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }
    expect((copyPlan.pipeline[0]?.$set as Record<string, unknown>).state).toEqual(copyState);

    const moveState = { moved: true };
    const movePlan = patch6902ToMongoUpdatePlan([{ op: 'move', from: '/from', path: '' }], moveState);
    expect(movePlan.mode).toBe('compiled-update-pipeline');
    if (movePlan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }
    expect((movePlan.pipeline[0]?.$set as Record<string, unknown>).state).toEqual(moveState);
  });

  test('compiles broader ordered mixed array/object sequence as pipeline', () => {
    const fullDocument = {
      profile: { status: 'published', title: 'new' },
      lines: ['a', 'x', 'b', 'd'],
      'meta.tag': 'v2'
    };

    const plan = patch6902ToMongoUpdatePlan(
      [
        { op: 'replace', path: '/profile/title', value: 'new' },
        { op: 'remove', path: '/lines/1' },
        { op: 'add', path: '/lines/2', value: 'b' },
        { op: 'add', path: '/meta.tag', value: 'v2' }
      ],
      fullDocument
    );

    expect(plan.mode).toBe('compiled-update-pipeline');
    if (plan.mode !== 'compiled-update-pipeline') {
      throw new Error('expected compiled-update-pipeline');
    }

    expect((plan.pipeline[0]?.$set as Record<string, unknown>).state).toEqual(fullDocument);
  });

  test('scenario: remove last array element via post-removal fullDocument compiles as $pop:1', () => {
    const fullDocument = {
      items: ['a', 'b']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/items/2' }], fullDocument);

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({});
    expect(plan.unset).toEqual([]);
    expect(plan.push).toEqual({});
    expect(plan.pop).toEqual({ items: 1 });
  });

  test('scenario: replace at empty-string key via pointer "/" targets empty-key property', () => {
    const fullDocument = {
      '': 42,
      other: 1
    };

    const plan = patch6902ToMongoUpdatePlan(
      [{ op: 'replace', path: '/', value: 42 }],
      fullDocument
    );

    expect(plan.mode).toBe('compiled-update-document');
    if (plan.mode !== 'compiled-update-document') {
      throw new Error('expected compiled-update-document');
    }

    expect(plan.set).toEqual({ '': 42 });
  });
});
