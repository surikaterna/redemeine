import type {
  SagaAggregateDefinition,
  SagaDefinition,
  SagaIntent,
  SagaIntentMetadata
} from '@redemeine/saga';

type SagaEventEnvelope = {
  readonly type: string;
  readonly payload: unknown;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  readonly sequence?: number;
  readonly metadata?: Partial<SagaIntentMetadata>;
};

export type TestSagaQueuedRequest = {
  readonly requestId: number;
  readonly token: string;
  readonly peerToken: string;
  readonly request: {
    readonly plugin_key: string;
    readonly action_name: string;
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
};

type RequestResponsePluginIntent = {
  readonly type?: string;
  readonly interaction?: string;
  readonly plugin_key?: string;
  readonly plugin?: string;
  readonly action_name?: string;
  readonly action?: string;
  readonly routing_metadata?: {
    readonly response_handler_key?: string;
    readonly error_handler_key?: string;
  };
  readonly metadata?: Partial<SagaIntentMetadata>;
};

export function areEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function assertMatches<TActual>(
  label: string,
  actual: TActual,
  expected: TActual | ((value: TActual) => boolean | void)
): void {
  if (typeof expected === 'function') {
    const matcher = expected as (value: TActual) => boolean | void;
    const result = matcher(actual);
    if (result === false) {
      throw new Error(`${label} expectation returned false`);
    }

    return;
  }

  if (!areEqual(actual, expected)) {
    throw new Error(`${label} mismatch\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`);
  }
}

export function resolveMetadata(metadata?: Partial<SagaIntentMetadata>): SagaIntentMetadata {
  return {
    sagaId: metadata?.sagaId ?? 'test-saga',
    correlationId: metadata?.correlationId ?? 'test-correlation',
    causationId: metadata?.causationId ?? 'test-causation'
  };
}

export function resolveHandlerForEvent(
  definition: SagaDefinition<any, any, any>, // SAFETY: saga types from ambient declarations (no DTS available)
  event: SagaEventEnvelope
): {
  readonly aggregate: SagaAggregateDefinition;
  readonly handler: (...args: any[]) => unknown; // SAFETY: command payload intentionally untyped for test flexibility
} | null {
  for (const registration of definition.handlers) {
    if (event.aggregateType !== undefined && registration.aggregateType !== event.aggregateType) {
      continue;
    }

    const explicit = registration.handlers[event.type];
    if (explicit !== undefined) {
      return {
        aggregate: registration.aggregate,
        handler: explicit
      };
    }

    const aggregatePrefix = `${registration.aggregateType}.`;
    const aggregateSuffix = '.event';

    if (event.type.startsWith(aggregatePrefix) && event.type.endsWith(aggregateSuffix)) {
      const eventName = event.type.slice(aggregatePrefix.length, -aggregateSuffix.length);
      const derived = registration.handlers[eventName];
      if (derived !== undefined) {
        return {
          aggregate: registration.aggregate,
          handler: derived
        };
      }
    }
  }

  return null;
}

export function enqueuePluginRequests(
  intents: readonly SagaIntent[],
  responseQueues: Map<string, TestSagaQueuedRequest[]>,
  errorQueues: Map<string, TestSagaQueuedRequest[]>,
  nextRequestId: { current: number }
): void {
  for (const intent of intents) {
    const maybeIntent = intent as unknown as RequestResponsePluginIntent;
    const isUnifiedRequest = maybeIntent.type === 'plugin-intent' && maybeIntent.interaction === 'request_response';
    const isLegacyRequest = maybeIntent.type === 'plugin-request';

    if (!isUnifiedRequest && !isLegacyRequest) {
      continue;
    }

    const pluginRequest = intent as RequestResponsePluginIntent;
    const responseToken = pluginRequest.routing_metadata?.response_handler_key;
    const errorToken = pluginRequest.routing_metadata?.error_handler_key;
    const pluginKey = pluginRequest.plugin_key ?? pluginRequest.plugin;
    const actionName = pluginRequest.action_name ?? pluginRequest.action;

    if (
      responseToken === undefined ||
      errorToken === undefined ||
      pluginKey === undefined ||
      actionName === undefined
    ) {
      continue;
    }

    const metadata = resolveMetadata(pluginRequest.metadata);
    const requestId = ++nextRequestId.current;

    const requestBase = {
      plugin_key: pluginKey,
      action_name: actionName,
      sagaId: metadata.sagaId,
      correlationId: metadata.correlationId,
      causationId: metadata.causationId
    };

    const responseItem: TestSagaQueuedRequest = {
      requestId,
      token: responseToken,
      peerToken: errorToken,
      request: requestBase
    };

    const errorItem: TestSagaQueuedRequest = {
      requestId,
      token: errorToken,
      peerToken: responseToken,
      request: requestBase
    };

    const responseQueue = responseQueues.get(responseItem.token) ?? [];
    responseQueue.push(responseItem);
    responseQueues.set(responseItem.token, responseQueue);

    const errorQueue = errorQueues.get(errorItem.token) ?? [];
    errorQueue.push(errorItem);
    errorQueues.set(errorItem.token, errorQueue);
  }
}

export function dequeueRequest(
  primaryQueue: Map<string, TestSagaQueuedRequest[]>,
  secondaryQueue: Map<string, TestSagaQueuedRequest[]>,
  token: string
): TestSagaQueuedRequest | undefined {
  const queue = primaryQueue.get(token);
  if (queue === undefined || queue.length === 0) {
    return undefined;
  }

  const next = queue.shift();
  if (queue.length === 0) {
    primaryQueue.delete(token);
  }

  if (next === undefined) {
    return undefined;
  }

  const peerQueue = secondaryQueue.get(next.peerToken);
  if (peerQueue !== undefined) {
    const peerIndex = peerQueue.findIndex((item) => item.requestId === next.requestId);
    if (peerIndex >= 0) {
      peerQueue.splice(peerIndex, 1);
    }

    if (peerQueue.length === 0) {
      secondaryQueue.delete(next.peerToken);
    }
  }

  return next;
}
