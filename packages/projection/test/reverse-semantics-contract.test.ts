import { describe, expect, it } from '@jest/globals';
import {
  planReverseRelink,
  planReverseSubscribe,
  planReverseUnsubscribe
} from '../src/reverseSemanticsContract';
import { reverseSemanticsFixture } from './fixtures/reverse-semantics.contract.fixture';

describe('reverse semantics contract', () => {
  it('specifies reverseSubscribe as multi-target add operations', () => {
    const mutations = planReverseSubscribe(reverseSemanticsFixture.subscribeMultiTarget);

    expect(mutations).toEqual([
      {
        op: 'add',
        link: { aggregateType: 'order', aggregateId: 'order-1', targetDocId: 'doc-a' }
      },
      {
        op: 'add',
        link: { aggregateType: 'order', aggregateId: 'order-1', targetDocId: 'doc-b' }
      }
    ]);
  });

  it('specifies relink as explicit remove+add (no replace op)', () => {
    const mutations = planReverseRelink(reverseSemanticsFixture.relinkRemoveAndAdd);

    expect(mutations).toEqual([
      {
        op: 'remove',
        link: { aggregateType: 'order', aggregateId: 'order-1', targetDocId: 'doc-a' }
      },
      {
        op: 'add',
        link: { aggregateType: 'order', aggregateId: 'order-1', targetDocId: 'doc-c' }
      }
    ]);

    // Contract guard: no implicit replace operation exists.
    for (const mutation of mutations) {
      expect(mutation.op === 'remove' || mutation.op === 'add').toBe(true);
      expect((mutation as { op: string }).op).not.toBe('replace');
    }
  });

  it('specifies missing target behavior as warn-and-skip for unsubscribe', () => {
    const sink = reverseSemanticsFixture.createWarningSink();
    const mutations = planReverseUnsubscribe({
      ...reverseSemanticsFixture.unsubscribeWarnAndSkip,
      warn: sink.warn
    });

    expect(mutations).toEqual([
      {
        op: 'remove',
        link: { aggregateType: 'order', aggregateId: 'order-1', targetDocId: 'doc-a' }
      }
    ]);

    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toMatchObject({
      code: 'missing_target',
      aggregateType: 'order',
      aggregateId: 'order-1',
      targetDocId: 'doc-missing'
    });
  });

  it('specifies missing target behavior as warn-and-skip for relink removals', () => {
    const sink = reverseSemanticsFixture.createWarningSink();

    const mutations = planReverseRelink({
      aggregateType: 'order',
      aggregateId: 'order-1',
      previousTargetDocIds: ['doc-old', 'doc-still-shared'],
      nextTargetDocIds: ['doc-still-shared', 'doc-next'],
      existingTargetDocIds: ['doc-still-shared'],
      warn: sink.warn
    });

    expect(mutations).toEqual([
      {
        op: 'add',
        link: { aggregateType: 'order', aggregateId: 'order-1', targetDocId: 'doc-next' }
      }
    ]);

    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toMatchObject({
      code: 'missing_target',
      targetDocId: 'doc-old'
    });
  });
});
