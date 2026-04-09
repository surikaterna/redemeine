import { describe, expect, test } from 'bun:test';
import { createProjectionRouter } from '../src';
import type { ProjectionDefinitionLike, ProjectionRouterEnvelope } from '../src';

const router = createProjectionRouter();

const projection: ProjectionDefinitionLike = {
  projectionName: 'invoice-summary',
  fromAggregateType: 'invoice',
  identity: (envelope) => envelope.sourceId
};

const baseEnvelope: ProjectionRouterEnvelope = {
  projectionName: 'invoice-summary',
  sourceStream: 'invoice',
  sourceId: 'invoice-1',
  eventName: 'created',
  payload: { amount: 100 }
};

describe('createProjectionRouter', () => {
  test('routes from-stream events to deterministic single target', () => {
    const decision = router.route(projection, baseEnvelope);

    expect(decision).toEqual({
      projectionName: 'invoice-summary',
      targets: [
        {
          targetId: 'invoice-1',
          laneKey: 'invoice-summary:invoice-1'
        }
      ]
    });
  });

  test('creates deterministic fanout with deduped multi-target identities', () => {
    const decision = router.route(
      {
        ...projection,
        identity: () => ['doc-2', 'doc-1', 'doc-2', 'doc-3']
      },
      baseEnvelope
    );

    expect(decision.targets).toEqual([
      { targetId: 'doc-2', laneKey: 'invoice-summary:doc-2' },
      { targetId: 'doc-1', laneKey: 'invoice-summary:doc-1' },
      { targetId: 'doc-3', laneKey: 'invoice-summary:doc-3' }
    ]);
  });

  test('does not route events from non-from streams', () => {
    const decision = router.route(projection, {
      ...baseEnvelope,
      sourceStream: 'payment',
      sourceId: 'payment-1'
    });

    expect(decision).toEqual({
      projectionName: 'invoice-summary',
      targets: []
    });
  });
});
