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
      mode: 'compiled',
      set: { profile: fullDocument.profile },
      unset: [],
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
      mode: 'compiled',
      set: { 'profile.address.city': 'Gothenburg' },
      unset: [],
      testGuards: []
    });
  });

  test('scenario: remove first array element compiles as parent array set', () => {
    const fullDocument = {
      lines: ['b', 'c', 'd']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/0' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: { lines: ['b', 'c', 'd'] },
      unset: [],
      testGuards: []
    });
  });

  test('scenario: remove middle element in long array compiles as parent array set', () => {
    const fullDocument = {
      lines: ['a', 'b', 'd', 'e', 'f']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/2' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: { lines: ['a', 'b', 'd', 'e', 'f'] },
      unset: [],
      testGuards: []
    });
  });

  test('scenario: remove last array element compiles as parent array set', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/lines/3' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: { lines: ['a', 'b', 'c'] },
      unset: [],
      testGuards: []
    });
  });

  test('scenario: add nested scalar compiles to leaf set', () => {
    const fullDocument = {
      meta: { status: 'open' }
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/meta/status', value: 'open' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: { 'meta.status': 'open' },
      unset: [],
      testGuards: []
    });
  });

  test('scenario: remove nested scalar compiles to unset', () => {
    const fullDocument = {
      meta: { keep: true }
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'remove', path: '/meta/obsolete' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: {},
      unset: ['meta.obsolete'],
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
      mode: 'compiled',
      set: { 'nested.keep': false },
      unset: [],
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
      mode: 'compiled',
      set: { snapshotTotal: 7 },
      unset: [],
      testGuards: []
    });
  });

  test('scenario: move operation compiles as unset source and set destination', () => {
    const fullDocument = {
      to: 'value'
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'move', from: '/from', path: '/to' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: { to: 'value' },
      unset: ['from'],
      testGuards: []
    });
  });

  test('scenario: add array element by index compiles as parent array set', () => {
    const fullDocument = {
      lines: ['a', 'b', 'c']
    };

    const plan = patch6902ToMongoUpdatePlan([{ op: 'add', path: '/lines/1', value: 'b' }], fullDocument);

    expect(plan).toEqual({
      mode: 'compiled',
      set: { lines: ['a', 'b', 'c'] },
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
