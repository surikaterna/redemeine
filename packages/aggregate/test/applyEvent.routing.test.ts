import { describe, expect, test } from '@jest/globals';
import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { produce } from 'immer';

function apply<S>(
  mode: 'apply' | 'applyToDraft',
  aggregate: { apply: (state: S, event: Event) => S; applyToDraft: (draft: S, event: Event) => void },
  state: S,
  event: Event
): S {
  return mode === 'apply'
    ? aggregate.apply(state, event)
    : produce(state, (draft) => {
        aggregate.applyToDraft(draft as S, event);
      });
}

describe.each(['apply', 'applyToDraft'] as const)('%s targeted event routing', (mode) => {
  test.each([false, true])('generated root events stay on root (matching containers: %s)', (matching) => {
    const state = {
      handled: '',
      rule: matching ? [{ id: 'r1', handled: '' }] : [],
      filter: matching ? { f1: { handled: '' } } : {}
    };
    const aggregate = createAggregate('routing', state)
      .events({
        removed: (draft) => {
          draft.handled = 'removed';
        },
        ruleRemoved: (draft) => {
          draft.handled = 'ruleRemoved';
        },
        filterRemoved: (draft) => {
          draft.handled = 'filterRemoved';
        }
      })
      .commands((emit) => ({
        remove: () => emit.removed({}),
        removeRule: () => emit.ruleRemoved({ ruleId: 'r1' }),
        removeFilter: () => emit.filterRemoved({ filterKey: 'f1' })
      }))
      .build();

    const cases = [
      [aggregate.commandCreators.remove(), 'routing.removed.event', 'removed'],
      [aggregate.commandCreators.removeRule(), 'routing.rule.removed.event', 'ruleRemoved'],
      [aggregate.commandCreators.removeFilter(), 'routing.filter.removed.event', 'filterRemoved']
    ] as const;

    for (const [command, type, handler] of cases) {
      const [event] = aggregate.process(state, command);
      expect(event.type).toBe(type);
      const result = apply(mode, aggregate, state, event);
      expect(result).toEqual({ ...state, handled: handler });
    }
    expect(state.handled).toBe('');
  });

  test('exact root handler is not retargeted into matching array or map containers', () => {
    const state = {
      handled: '',
      rule: [{ id: 'r1', handled: '' }],
      filter: { f1: { handled: '' } }
    };
    // No core "removed" handler: this isolates traversal from terminal-action dispatch.
    const aggregate = createAggregate('routing', state)
      .events({
        ruleRemoved: (draft) => {
          draft.handled = 'ruleRemoved';
        },
        filterRemoved: (draft) => {
          draft.handled = 'filterRemoved';
        }
      })
      .build();

    for (const [type, payload, handler] of [
      ['routing.rule.removed.event', { ruleId: 'r1' }, 'ruleRemoved'],
      ['routing.filter.removed.event', { filterKey: 'f1' }, 'filterRemoved']
    ] as const) {
      const result = apply(mode, aggregate, state, { type, payload });
      expect(result).toEqual({ ...state, handled: handler });
    }
    expect(state.handled).toBe('');
  });

  test('legacy targeted events still traverse to the core updated handler', () => {
    type Line = { id: string; qty: number };
    const state = {
      lines: [
        { id: 'l1', qty: 1 },
        { id: 'l2', qty: 2 }
      ]
    };
    const aggregate = createAggregate('routing', state)
      .events({
        updated: (draft, event: Event<{ qty: number }>) => {
          // Legacy projectors receive the traversed entity, not the declared root state.
          (draft as unknown as Line).qty = event.payload.qty;
        }
      })
      .build();

    const result = apply(mode, aggregate, state, {
      type: 'routing.line.updated.event',
      payload: { lineId: 'l1', qty: 9 }
    });
    expect(result.lines).toEqual([
      { id: 'l1', qty: 9 },
      { id: 'l2', qty: 2 }
    ]);
    expect(state.lines[0].qty).toBe(1);
  });

  test('mounted scoped handlers beat colliding root camelCase handlers with shared event keys', () => {
    type Item = { id: string; handled: string };
    const state = {
      handled: '',
      rule: [{ id: 'r1', handled: '' }],
      filter: [{ id: 'f1', handled: '' }]
    };
    const rule = createEntity<Item, 'rule'>('rule')
      .events({
        removed: (draft) => {
          draft.handled = 'mounted rule';
        }
      })
      .build();
    const filter = createEntity<Item, 'filter'>('filter')
      .events({
        removed: (draft) => {
          draft.handled = 'mounted filter';
        }
      })
      .build();
    const aggregate = createAggregate('routing', state)
      .entityList('rule', rule)
      .entityList('filter', filter)
      .events({
        ruleRemoved: (draft) => {
          draft.handled = 'root rule';
        },
        filterRemoved: (draft) => {
          draft.handled = 'root filter';
        }
      })
      .build();

    const afterRule = apply(mode, aggregate, state, {
      type: 'routing.rule.removed.event',
      payload: { ruleId: 'r1' }
    });
    const result = apply(mode, aggregate, afterRule, {
      type: 'routing.filter.removed.event',
      payload: { filterId: 'f1' }
    });
    expect(result).toEqual({
      handled: '',
      rule: [{ id: 'r1', handled: 'mounted rule' }],
      filter: [{ id: 'f1', handled: 'mounted filter' }]
    });
    expect(state.rule[0].handled).toBe('');
    expect(state.filter[0].handled).toBe('');
  });
});
