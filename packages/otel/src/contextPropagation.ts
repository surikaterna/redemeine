import { listAdapters } from './adapterRegistry';
import type { MutableTelemetryCarrier, TelemetryCarrier, TelemetryContext } from './types';

export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = Object.freeze({
  values: Object.freeze({})
});

export function extractContext(carrier: TelemetryCarrier): TelemetryContext {
  const adapters = listAdapters();

  for (const adapter of adapters) {
    const extracted = adapter.extract?.(carrier) ?? null;
    if (extracted != null) {
      return extracted;
    }
  }

  return NOOP_TELEMETRY_CONTEXT;
}

export function injectContext(context: TelemetryContext, carrier: MutableTelemetryCarrier): MutableTelemetryCarrier {
  const adapters = listAdapters();

  for (const adapter of adapters) {
    adapter.inject?.(context, carrier);
  }

  return carrier;
}
