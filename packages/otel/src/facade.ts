import { getAdapter } from './adapterRegistry';
import { NOOP_TELEMETRY_CONTEXT, extractContext, injectContext } from './contextPropagation';
import type {
  MutableTelemetryCarrier,
  TelemetryAdapter,
  TelemetryCarrier,
  TelemetryContext
} from './types';

const DEFAULT_ADAPTER_ID = 'default';

export interface TelemetryFacade {
  readonly adapter: TelemetryAdapter | null;
  readonly isNoop: boolean;
  extract(carrier: TelemetryCarrier): TelemetryContext;
  inject(context: TelemetryContext, carrier: MutableTelemetryCarrier): MutableTelemetryCarrier;
}

export function createTelemetryFacade(adapterId: string = DEFAULT_ADAPTER_ID): TelemetryFacade {
  const adapter = getAdapter(adapterId) ?? null;

  return {
    adapter,
    isNoop: adapter == null,
    extract: (carrier) => {
      if (adapter?.extract != null) {
        return adapter.extract(carrier) ?? NOOP_TELEMETRY_CONTEXT;
      }

      return extractContext(carrier);
    },
    inject: (context, carrier) => {
      if (adapter?.inject != null) {
        adapter.inject(context, carrier);
        return carrier;
      }

      return injectContext(context, carrier);
    }
  };
}
