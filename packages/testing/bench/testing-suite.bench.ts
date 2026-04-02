import { performance } from 'node:perf_hooks';
import { createProjection } from '../../projection/src';
import { createSaga, type CanonicalSagaIdentityInput } from '../../saga/src';
import { createTestDepot } from '../src';
import { testAggregate } from '../src/testAggregate';
import { testProjection } from '../src/testProjection';
import { testSaga } from '../src/testSaga';

type BenchResult = {
  readonly name: string;
  readonly iterations: number;
  readonly assertions: number;
  readonly elapsedMs: number;
};

const benchMetadata = {
  mode: 'informational-baseline',
  targetAssertions: 1000,
  timestamp: new Date().toISOString(),
  bunVersion: process.versions.bun ?? 'unknown',
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  gitSha: process.env.GITHUB_SHA ?? null
} as const;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`benchmark assertion failed: ${message}`);
  }
}

function toPerAssertionMs(elapsedMs: number, assertions: number): number {
  return Number((elapsedMs / Math.max(assertions, 1)).toFixed(4));
}

async function benchmarkAggregateFixture(iterations: number): Promise<BenchResult> {
  class AlreadyOpenedError extends Error {
    constructor() {
      super('Account already opened');
      this.name = 'AlreadyOpenedError';
    }
  }

  type AccountState = {
    readonly id: string;
    readonly opened: boolean;
    readonly balance: number;
  };

  const accountAggregate = {
    initialState: {
      id: 'acc-1',
      opened: false,
      balance: 0
    } as AccountState,
    apply(state: AccountState, event: { readonly type: string; readonly payload: unknown }): AccountState {
      switch (event.type) {
        case 'account.opened.event':
          return { ...state, opened: true };
        case 'account.deposited.event':
          return { ...state, balance: state.balance + (event.payload as { amount: number }).amount };
        default:
          return state;
      }
    },
    process(state: AccountState, command: { readonly type: string; readonly payload: unknown }) {
      switch (command.type) {
        case 'account.open.command':
          if (state.opened) {
            throw new AlreadyOpenedError();
          }

          return [{ type: 'account.opened.event', payload: { id: state.id } }];
        case 'account.deposit.command':
          return [{ type: 'account.deposited.event', payload: { amount: (command.payload as { amount: number }).amount } }];
        default:
          throw new Error(`Unknown command ${command.type}`);
      }
    },
    commandCreators: {
      deposit: (payload: { amount: number }) => ({
        type: 'account.deposit.command',
        payload
      })
    }
  } as const;

  let assertions = 0;
  const started = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    const fixture = testAggregate(accountAggregate)
      .given([{ type: 'account.opened.event', payload: { id: 'acc-1' } }])
      .when('deposit', { amount: 5 });

    assert(fixture.getEmittedEvents().length === 1, 'aggregate emitted events count should be 1');
    assertions += 1;

    assert(fixture.getState().balance === 5, 'aggregate state balance should be 5');
    assertions += 1;
  }

  return {
    name: 'testAggregate',
    iterations,
    assertions,
    elapsedMs: Number((performance.now() - started).toFixed(2))
  };
}

async function benchmarkProjectionFixture(iterations: number): Promise<BenchResult> {
  type CounterState = { total: number; events: number };

  const counterAggregate = {
    __aggregateType: 'counter' as const,
    pure: {
      eventProjectors: {
        incremented: (_state: unknown, _event: { payload: { amount: number } }) => undefined
      }
    }
  };

  const projection = createProjection<CounterState>('counter-summary', () => ({ total: 0, events: 0 }))
    .from(counterAggregate, {
      incremented: (state, event) => {
        state.total += Number(event.payload.amount);
        state.events += 1;
      }
    })
    .build();

  let assertions = 0;
  const started = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    const fixture = testProjection(projection).withState({ total: 0, events: 0 });
    const result = fixture.applyEvent({
      aggregateType: 'counter',
      aggregateId: `counter-${index}`,
      type: 'counter.incremented.event',
      payload: { amount: 2 },
      sequence: 1,
      timestamp: '2026-04-02T00:00:00.000Z'
    });

    assert(result.state.total === 2, 'projection total should be 2');
    assertions += 1;

    assert(result.patches.length === 2, 'projection should emit two patches');
    assertions += 1;
  }

  return {
    name: 'testProjection',
    iterations,
    assertions,
    elapsedMs: Number((performance.now() - started).toFixed(2))
  };
}

async function benchmarkSagaFixture(iterations: number): Promise<BenchResult> {
  const PaymentAggregate = {
    __aggregateType: 'payment',
    commandCreators: {
      'payment.capture': (id: string) => ({
        type: 'payment.capture',
        payload: { id }
      })
    },
    pure: {
      eventProjectors: {
        started: (_state: unknown, _event: { payload: { id: string } }) => undefined
      }
    }
  } as const;

  const identity: CanonicalSagaIdentityInput = {
    namespace: 'bench.saga',
    name: 'simple',
    version: 1
  };

  const saga = createSaga<{ attempts: number }>({ identity })
    .initialState(() => ({ attempts: 0 }))
    .on(PaymentAggregate, {
      started: (_state, event, ctx) => {
        const typedEvent = event as { payload: { id: string } };
        ctx.emit({
          type: 'plugin-request',
          plugin_key: 'payments',
          action_name: 'capture',
          action_kind: 'request_response',
          execution_payload: { id: typedEvent.payload.id },
          routing_metadata: {
            response_handler_key: 'payment.capture.ok',
            error_handler_key: 'payment.capture.failed',
            handler_data: {}
          },
          metadata: ctx.metadata
        });
      }
    })
    .onResponses({
      'payment.capture.ok': (state) => {
        state.attempts += 1;
      }
    })
    .onErrors({
      'payment.capture.failed': () => undefined
    })
    .build();

  let assertions = 0;
  const started = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    const fixture = testSaga(saga);
    await fixture.receiveEvent({
      type: 'started',
      payload: { id: `payment-${index}` },
      aggregateType: 'payment',
      metadata: {
        sagaId: `saga-${index}`,
        correlationId: `corr-${index}`,
        causationId: `cause-${index}`
      }
    });

    const response = await fixture.invokeResponse('payment.capture.ok', 'ok');
    assert(response.ok === true, 'saga response invoke should succeed');
    assertions += 1;

    const sagaState = fixture.getState() as { attempts: number };
    assert(sagaState.attempts === 1, 'saga attempts should be incremented');
    assertions += 1;
  }

  return {
    name: 'testSaga',
    iterations,
    assertions,
    elapsedMs: Number((performance.now() - started).toFixed(2))
  };
}

async function benchmarkDepotFixture(iterations: number): Promise<BenchResult> {
  type CounterState = { count: number };
  type CounterView = { id: string; total: number; events: number };

  const CounterAggregate = {
    __aggregateType: 'counter',
    initialState: { count: 0 } as CounterState,
    process(_state: CounterState, command: { type: string; payload: { id: string; amount: number } }) {
      if (command.type === 'counter.increment.command') {
        return [
          {
            type: 'counter.incremented.event',
            payload: { amount: command.payload.amount },
            metadata: { aggregateId: command.payload.id }
          }
        ];
      }

      throw new Error(`Unknown command: ${command.type}`);
    },
    apply(state: CounterState, event: { type: string; payload: { amount: number } }) {
      if (event.type === 'counter.incremented.event') {
        return {
          ...state,
          count: state.count + event.payload.amount
        };
      }

      return state;
    },
    commandCreators: {
      increment(id: string, amount: number) {
        return {
          type: 'counter.increment.command',
          payload: { id, amount }
        };
      }
    },
    eventCreators: {},
    pure: {
      commandProcessors: {
        'counter.increment.command': () => undefined
      },
      eventProjectors: {}
    },
    selectors: {}
  } as const;

  const counterProjection = {
    name: 'counter-view',
    fromStream: {
      aggregate: CounterAggregate as any,
      handlers: {
        'counter.incremented.event': (state: CounterView, event: any) => {
          state.id = event.aggregateId;
          state.total += Number(event.payload.amount);
          state.events += 1;
        }
      }
    },
    joinStreams: [],
    initialState: (id: string): CounterView => ({
      id,
      total: 0,
      events: 0
    }),
    identity: (event: { aggregateId: string }) => event.aggregateId,
    subscriptions: []
  } as const;

  let assertions = 0;
  const started = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    const id = `counter-${index}`;
    const depot = createTestDepot({
      aggregates: [CounterAggregate as any],
      projections: [counterProjection]
    });

    await depot.dispatch(CounterAggregate.commandCreators.increment(id, 2));
    await depot.dispatch(CounterAggregate.commandCreators.increment(id, 3));
    await depot.waitForIdle();

    const view = await depot.projections.get(counterProjection, id);
    assert(view?.total === 5, 'test depot total should be 5');
    assertions += 1;

    assert(view?.events === 2, 'test depot events should be 2');
    assertions += 1;
  }

  return {
    name: 'createTestDepot',
    iterations,
    assertions,
    elapsedMs: Number((performance.now() - started).toFixed(2))
  };
}

async function run(): Promise<void> {
  const results = [
    await benchmarkAggregateFixture(200),
    await benchmarkProjectionFixture(200),
    await benchmarkSagaFixture(80),
    await benchmarkDepotFixture(20)
  ];

  const totalElapsedMs = Number(results.reduce((sum, result) => sum + result.elapsedMs, 0).toFixed(2));
  const totalAssertions = results.reduce((sum, result) => sum + result.assertions, 0);

  console.log('Benchmark metadata');
  console.table(benchMetadata);

  console.log('Fixture benchmark results (baseline, informational only)');
  console.table(
    results.map((result) => ({
      fixture: result.name,
      iterations: result.iterations,
      assertions: result.assertions,
      elapsedMs: result.elapsedMs,
      perAssertionMs: toPerAssertionMs(result.elapsedMs, result.assertions)
    }))
  );

  console.log('Benchmark summary');
  console.log(
    JSON.stringify(
      {
        metadata: benchMetadata,
        totalElapsedMs,
        totalAssertions,
        fixtures: results
      },
      null,
      2
    )
  );

  assert(totalAssertions >= benchMetadata.targetAssertions, `expected at least ${benchMetadata.targetAssertions} assertions`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
