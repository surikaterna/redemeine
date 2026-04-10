import { describe, expect, test } from 'bun:test';
import { createProjectionRouter } from '../src';
import type { ProjectionDefinitionLike, ProjectionRouterEnvelope } from '../src';

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
  test('routes from-stream events to deterministic single target', async () => {
    const router = createProjectionRouter();
    const decision = await router.route(projection, baseEnvelope);

    expect(decision).toEqual({
      projectionName: 'invoice-summary',
      targets: [
        {
          targetId: 'invoice-1',
          laneKey: 'invoice-summary:invoice-1'
        }
      ],
      warnings: []
    });
  });

  test('creates deterministic fanout with deduped multi-target identities', async () => {
    const router = createProjectionRouter();
    const decision = await router.route(
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
    expect(decision.warnings).toEqual([]);
  });

  test('does not route events from non-from streams', async () => {
    const router = createProjectionRouter();
    const decision = await router.route(projection, {
      ...baseEnvelope,
      sourceStream: 'payment',
      sourceId: 'payment-1'
    });

    expect(decision).toEqual({
      projectionName: 'invoice-summary',
      targets: [],
      warnings: []
    });
  });

  test('unions reverse rules with persisted link targets', async () => {
    const router = createProjectionRouter();

    const definition: ProjectionDefinitionLike = {
      ...projection,
      reverseRules: [
        {
          aggregateType: 'customer',
          targetIdentity: () => ['doc-rule', 'doc-shared']
        }
      ],
      reverseLinkMutations: (envelope) =>
        envelope.eventName === 'linked'
          ? [
              {
                op: 'add',
                aggregateType: envelope.sourceStream,
                aggregateId: envelope.sourceId,
                targetId: 'doc-link'
              },
              {
                op: 'add',
                aggregateType: envelope.sourceStream,
                aggregateId: envelope.sourceId,
                targetId: 'doc-shared'
              }
            ]
          : []
    };

    await router.route(definition, {
      ...baseEnvelope,
      sourceStream: 'customer',
      sourceId: 'customer-1',
      eventName: 'linked'
    });

    const decision = await router.route(definition, {
      ...baseEnvelope,
      sourceStream: 'customer',
      sourceId: 'customer-1',
      eventName: 'updated'
    });

    expect(decision.targets).toEqual([
      { targetId: 'doc-link', laneKey: 'invoice-summary:doc-link' },
      { targetId: 'doc-shared', laneKey: 'invoice-summary:doc-shared' },
      { targetId: 'doc-rule', laneKey: 'invoice-summary:doc-rule' }
    ]);
    expect(decision.warnings).toEqual([]);
  });

  test('applies relink semantics as remove plus add', async () => {
    const router = createProjectionRouter();

    const definition: ProjectionDefinitionLike = {
      ...projection,
      reverseRules: [{ aggregateType: 'customer', targetIdentity: () => [] }],
      reverseLinkMutations: (envelope) => {
        if (envelope.eventName === 'linked') {
          return [
            {
              op: 'add',
              aggregateType: envelope.sourceStream,
              aggregateId: envelope.sourceId,
              targetId: String((envelope.payload as { targetId: string }).targetId)
            }
          ];
        }

        if (envelope.eventName === 'relinked') {
          const payload = envelope.payload as { previousTargetId: string; nextTargetId: string };
          return [
            {
              op: 'remove',
              aggregateType: envelope.sourceStream,
              aggregateId: envelope.sourceId,
              targetId: payload.previousTargetId
            },
            {
              op: 'add',
              aggregateType: envelope.sourceStream,
              aggregateId: envelope.sourceId,
              targetId: payload.nextTargetId
            }
          ];
        }

        return [];
      }
    };

    await router.route(definition, {
      ...baseEnvelope,
      sourceStream: 'customer',
      sourceId: 'customer-1',
      eventName: 'linked',
      payload: { targetId: 'doc-old' }
    });

    const decision = await router.route(definition, {
      ...baseEnvelope,
      sourceStream: 'customer',
      sourceId: 'customer-1',
      eventName: 'relinked',
      payload: { previousTargetId: 'doc-old', nextTargetId: 'doc-new' }
    });

    expect(decision.targets).toEqual([
      { targetId: 'doc-new', laneKey: 'invoice-summary:doc-new' }
    ]);
    expect(decision.warnings).toEqual([]);
  });

  test('warns and skips missing targets without failing fanout', async () => {
    const router = createProjectionRouter({
      hasTarget: (targetId) => targetId !== 'doc-missing'
    });

    const definition: ProjectionDefinitionLike = {
      ...projection,
      reverseRules: [
        {
          aggregateType: 'customer',
          targetIdentity: () => ['doc-existing', 'doc-missing']
        }
      ]
    };

    const decision = await router.route(definition, {
      ...baseEnvelope,
      sourceStream: 'customer',
      sourceId: 'customer-3',
      eventName: 'updated'
    });

    expect(decision.targets).toEqual([
      { targetId: 'doc-existing', laneKey: 'invoice-summary:doc-existing' }
    ]);
    expect(decision.warnings).toEqual([
      {
        code: 'missing_reverse_target',
        projectionName: 'invoice-summary',
        aggregateType: 'customer',
        aggregateId: 'customer-3',
        eventName: 'updated',
        targetId: 'doc-missing'
      }
    ]);
  });

  test('warns when remove mutation targets missing persisted link', async () => {
    const router = createProjectionRouter();

    const definition: ProjectionDefinitionLike = {
      ...projection,
      reverseRules: [
        {
          aggregateType: 'customer',
          targetIdentity: () => 'doc-still-present'
        }
      ],
      reverseLinkMutations: (envelope) =>
        envelope.eventName === 'unlinked'
          ? [
              {
                op: 'remove',
                aggregateType: envelope.sourceStream,
                aggregateId: envelope.sourceId,
                targetId: 'doc-never-linked'
              }
            ]
          : []
    };

    const decision = await router.route(definition, {
      ...baseEnvelope,
      sourceStream: 'customer',
      sourceId: 'customer-2',
      eventName: 'unlinked'
    });

    expect(decision.targets).toEqual([
      { targetId: 'doc-still-present', laneKey: 'invoice-summary:doc-still-present' }
    ]);
    expect(decision.warnings).toEqual([
      {
        code: 'missing_target_removal',
        projectionName: 'invoice-summary',
        aggregateType: 'customer',
        aggregateId: 'customer-2',
        eventName: 'unlinked',
        targetId: 'doc-never-linked'
      }
    ]);
  });
});
