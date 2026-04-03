import { describe, expect, it } from '@jest/globals';
import {
  createSagaAggregate,
  createSagaInboundRouter,
  SagaTransitionInvariantError,
  type SagaAggregateState
} from '../src';

const isoAt = (secondsOffset: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, secondsOffset)).toISOString();

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

describe('saga inbound router', () => {
  it('serializes inbound processing per saga in deterministic arrival order', async () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const gate = createDeferred();
    const observedOrder: string[] = [];

    const router = createSagaInboundRouter({
      aggregate,
      beforeProcess: async (input) => {
        observedOrder.push(`start:${input.command.type}`);
        if (input.command.type === 'saga.create_instance.command') {
          await gate.promise;
        }
        observedOrder.push(`end:${input.command.type}`);
      }
    });

    const sagaId = 'saga-serial-1';

    const createPromise = router.route({
      sagaId,
      command: aggregate.commandCreators.createInstance({
        id: sagaId,
        sagaType: 'shipping',
        createdAt: isoAt(1)
      })
    });

    const observePromise = router.route({
      sagaId,
      command: aggregate.commandCreators.observeSourceEvent({
        eventType: 'order.created.event',
        observedAt: isoAt(2)
      })
    });

    const transitionPromise = router.route({
      sagaId,
      command: aggregate.commandCreators.recordStateTransition({
        fromState: 'active',
        toState: 'completed',
        transitionAt: isoAt(3)
      })
    });

    gate.resolve();

    const [createResult, observeResult, transitionResult] = await Promise.all([
      createPromise,
      observePromise,
      transitionPromise
    ]);

    expect(observedOrder).toEqual([
      'start:saga.create_instance.command',
      'end:saga.create_instance.command',
      'start:saga.observe_source_event.command',
      'end:saga.observe_source_event.command',
      'start:saga.record_state_transition.command',
      'end:saga.record_state_transition.command'
    ]);

    expect(createResult.sagaSequence).toBe(1);
    expect(observeResult.sagaSequence).toBe(2);
    expect(transitionResult.sagaSequence).toBe(3);
    expect([createResult.inboundSequence, observeResult.inboundSequence, transitionResult.inboundSequence]).toEqual([1, 2, 3]);

    const finalState = router.getState(sagaId) as SagaAggregateState;
    expect(finalState.lifecycleState).toBe('completed');
    expect(finalState.transitionVersion).toBe(3);
    expect(finalState.totals.observedEvents).toBe(1);
    expect(finalState.totals.transitions).toBe(1);
  });

  it('keeps strict single-flight scoped per saga id by default', async () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const gate = createDeferred();
    const starts: string[] = [];

    const router = createSagaInboundRouter({
      aggregate,
      beforeProcess: async (input) => {
        starts.push(`${input.sagaId}:${input.command.type}`);
        if (input.sagaId === 'saga-a') {
          await gate.promise;
        }
      }
    });

    const sagaA = router.route({
      sagaId: 'saga-a',
      command: aggregate.commandCreators.createInstance({ id: 'saga-a', sagaType: 'shipping', createdAt: isoAt(1) })
    });

    const sagaB = router.route({
      sagaId: 'saga-b',
      command: aggregate.commandCreators.createInstance({ id: 'saga-b', sagaType: 'shipping', createdAt: isoAt(2) })
    });

    const sagaBResult = await sagaB;
    expect(sagaBResult.sagaId).toBe('saga-b');
    expect(starts).toContain('saga-b:saga.create_instance.command');

    gate.resolve();
    await sagaA;
  });

  it('supports configurable arrival_order waiting policy', async () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const observedOrder: string[] = [];

    const router = createSagaInboundRouter({
      aggregate,
      resolveWaitingPolicy: () => 'arrival_order',
      beforeProcess: (input) => {
        observedOrder.push(input.command.type);
      }
    });

    const sagaId = 'saga-arrival-order-1';
    const createResult = await router.route({
      sagaId,
      command: aggregate.commandCreators.createInstance({ id: sagaId, sagaType: 'shipping', createdAt: isoAt(1) }),
      coordination: { stepId: 'fan-in', barrierSize: 2 }
    });

    const observeResult = await router.route({
      sagaId,
      command: aggregate.commandCreators.observeSourceEvent({ eventType: 'order.created.event', observedAt: isoAt(2) }),
      coordination: { stepId: 'fan-in', barrierSize: 2 }
    });

    expect(observedOrder).toEqual([
      'saga.create_instance.command',
      'saga.observe_source_event.command'
    ]);
    expect(createResult.sagaSequence).toBe(1);
    expect(observeResult.sagaSequence).toBe(2);
  });

  it('supports barrier_gated waiting policy for coordinated fan-in', async () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const observedOrder: string[] = [];

    const router = createSagaInboundRouter({
      aggregate,
      resolveWaitingPolicy: () => 'barrier_gated',
      beforeProcess: (input) => {
        observedOrder.push(input.command.type);
      }
    });

    const sagaId = 'saga-barrier-1';
    const first = router.route({
      sagaId,
      command: aggregate.commandCreators.createInstance({ id: sagaId, sagaType: 'shipping', createdAt: isoAt(1) }),
      coordination: { stepId: 'shipping-fan-in', barrierSize: 2 }
    });

    await Promise.resolve();
    expect(observedOrder).toEqual([]);

    const second = router.route({
      sagaId,
      command: aggregate.commandCreators.observeSourceEvent({ eventType: 'order.created.event', observedAt: isoAt(2) }),
      coordination: { stepId: 'shipping-fan-in', barrierSize: 2 }
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(observedOrder).toEqual([
      'saga.create_instance.command',
      'saga.observe_source_event.command'
    ]);
    expect([firstResult.inboundSequence, secondResult.inboundSequence]).toEqual([1, 2]);
  });

  it('rejects barrier_gated policy when coordination step id is missing', async () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const router = createSagaInboundRouter({
      aggregate,
      resolveWaitingPolicy: () => 'barrier_gated'
    });

    await expect(
      router.route({
        sagaId: 'saga-barrier-missing-step',
        command: aggregate.commandCreators.createInstance({
          id: 'saga-barrier-missing-step',
          sagaType: 'shipping',
          createdAt: isoAt(1)
        })
      })
    ).rejects.toThrow('barrier_gated waiting policy requires coordination.stepId');
  });

  it('propagates SagaAggregate invariant rejections through serialized routing', async () => {
    const aggregate = createSagaAggregate({ aggregateName: 'saga' });
    const router = createSagaInboundRouter({ aggregate });
    const sagaId = 'saga-invariant-1';

    await router.route({
      sagaId,
      command: aggregate.commandCreators.createInstance({ id: sagaId, sagaType: 'shipping', createdAt: isoAt(1) })
    });

    const duplicateCreate = router.route({
      sagaId,
      command: aggregate.commandCreators.createInstance({ id: sagaId, sagaType: 'shipping', createdAt: isoAt(2) })
    });

    try {
      await duplicateCreate;
      throw new Error('expected duplicate create to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(SagaTransitionInvariantError);
      expect(error).toMatchObject({
        code: 'saga_instance_already_created',
        details: {
          command: 'createInstance',
          sagaId
        }
      });
    }
  });
});
