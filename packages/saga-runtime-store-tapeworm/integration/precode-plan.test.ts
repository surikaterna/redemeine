import { describe, expect, it } from '@jest/globals';
import { inspectIntentExplain } from './precode-plan';

const ix = { stage: 'IXSCAN', indexName: 'vpwm_type_id', keyPattern: { 'events.type': 1, _id: 1 } };
const explain = (winningPlan: unknown, keys = 80) => ({ queryPlanner: { winningPlan },
  executionStats: { totalKeysExamined: keys, totalDocsExamined: 64, nReturned: 64 } });

describe('PRECODE explain parser (offline)', () => {
  it('accepts explicit classic and SBE selected index with measured selectivity', () => {
    const classic = inspectIntentExplain(explain({ stage: 'FETCH', inputStage: ix }));
    expect(classic).toMatchObject({ shape: 'classic', indexName: 'vpwm_type_id', returned: 64, keysPerReturned: 1.25 });
    const sbe = inspectIntentExplain(explain({ queryPlan: { stage: 'FETCH', inputStage: ix }, slotBasedPlan: { stages: 'opaque' } }));
    expect(sbe).toMatchObject({ shape: 'SBE', indexName: 'vpwm_type_id', docsPerReturned: 1 });
  });

  it('rejects alternative index, bad keyPattern, table scan, sort and unknown plan shapes', () => {
    const invalid = [
      { ...ix, indexName: '_id_' }, { ...ix, keyPattern: { _id: 1 } },
      { stage: 'COLLSCAN' }, { stage: 'SORT', inputStage: ix },
      { stage: 'FETCH', inputStages: [ix] }, { slotBasedPlan: { stages: 'ixscan' } },
      { queryPlan: ix }, { stage: 'MYSTERY', inputStage: ix }
    ];
    for (const plan of invalid) expect(() => inspectIntentExplain(explain(plan))).toThrow();
    expect(() => inspectIntentExplain(explain(ix, 641))).toThrow('Nonselective');
  });
});
