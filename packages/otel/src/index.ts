export * from './types';
export * from './adapterRegistry';
export * from './contextPropagation';
export * from './facade';
export * from './semconv';
import {
  createInMemoryTelemetryPluginV1,
  type SagaRuntimeTelemetryEvent,
  type SagaRuntimeTelemetryPluginV1
} from '../../saga-runtime/src';

export interface OTelBridgeOptions {
  readonly emitSpan?: (event: SagaRuntimeTelemetryEvent) => void;
  readonly baseTelemetry?: SagaRuntimeTelemetryPluginV1;
}

export interface OTelBridgeTelemetryPlugin extends SagaRuntimeTelemetryPluginV1 {
  readonly instrumentation: '@redemeine/otel';
}

const isSpanEvent = (eventName: string): boolean => eventName === 'saga.intent.executed';

export const createOtelTelemetryBridge = (options: OTelBridgeOptions = {}): OTelBridgeTelemetryPlugin => {
  const base = options.baseTelemetry ?? createInMemoryTelemetryPluginV1();

  return {
    instrumentation: '@redemeine/otel',
    count(metric, delta = 1) {
      base.count(metric, delta);
    },
    event(name, tags) {
      const at = new Date().toISOString();
      base.event(name, tags);

      if (isSpanEvent(name) && options.emitSpan) {
        options.emitSpan({ name, tags, at });
      }
    },
    snapshot() {
      return base.snapshot();
    }
  };
};
