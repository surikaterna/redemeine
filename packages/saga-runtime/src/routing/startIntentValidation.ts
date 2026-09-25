import type { SagaIntent, SagaIntentMetadata, SagaPluginManifestList, SagaResponseHandlerTokenBindings } from '@redemeine/saga';
import { normalizePluginIntent, validateIntentBatch, type WireIntent, type WireOrigin, type WireRegistryEntry } from '../intentWire';
import { serializeSagaCorrelation } from '../identity/canonicalCorrelation';
import { deriveSagaInstanceId } from '../identity/deterministicIds';

export type StartTurnOrigin = Omit<WireOrigin, 'ordinal'>;

export function startWireRegistry(manifests: SagaPluginManifestList, commandTypes: readonly string[]): readonly WireRegistryEntry[] {
  return [
    ...manifests.map((manifest) => ({
      plugin_key: manifest.plugin_key,
      actions: Object.entries(manifest.actions).map(([name, action]) => ({ name, interaction: action.interaction }))
    })),
    { plugin_key: 'core', actions: [], commandTypes }
  ];
}

function validateRoute(intent: WireIntent, bindings: SagaResponseHandlerTokenBindings): void {
  if (intent.kind !== 'plugin' || intent.interaction !== 'request_response') return;
  const route = intent.routing_metadata;
  if (bindings[route.response_handler_key]?.phase !== 'response' || bindings[route.error_handler_key]?.phase !== 'error' ||
      (route.retry_handler_key !== undefined && bindings[route.retry_handler_key]?.phase !== 'retry')) {
    throw new TypeError('Unregistered saga response/error/retry route');
  }
}

export function validateStartIntents(
  intents: readonly SagaIntent[], origin: StartTurnOrigin, metadata: SagaIntentMetadata,
  registry: readonly WireRegistryEntry[], bindings: SagaResponseHandlerTokenBindings, turnClock: string
): readonly WireIntent[] {
  if (!origin || !origin.sagaKey || !origin.sourceId || !origin.routeId || !origin.correlation ||
      typeof turnClock !== 'string' || !Number.isFinite(Date.parse(turnClock)) ||
      new Date(turnClock).toISOString() !== turnClock ||
      metadata.sagaId !== deriveSagaInstanceId(origin.sagaKey, origin.correlation) ||
      metadata.correlationId !== serializeSagaCorrelation(origin.correlation) || metadata.causationId !== origin.sourceId) {
    throw new TypeError('Invalid saga turn origin, clock or metadata');
  }
  const wire = intents.map((intent, ordinal) => {
    if (!intent || intent.type !== 'plugin-intent' || intent.metadata.sagaId !== metadata.sagaId ||
        intent.metadata.correlationId !== metadata.correlationId || intent.metadata.causationId !== metadata.causationId) {
      throw new TypeError('Unsupported or mismatched emitted intent');
    }
    const checked = normalizePluginIntent(intent, { ...origin, ordinal }, registry, turnClock);
    validateRoute(checked, bindings);
    return checked;
  });
  return validateIntentBatch(wire, registry);
}
