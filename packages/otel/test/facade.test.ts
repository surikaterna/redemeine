import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  clearAdapters,
  createTelemetryFacade,
  registerAdapter,
  type TelemetryContext
} from '../src';

describe('telemetry facade', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('is no-op safe when no adapter is registered', () => {
    const facade = createTelemetryFacade();
    const extracted = facade.extract({ traceparent: 'ignored' });
    const carrier = facade.inject(extracted, {});

    expect(facade.isNoop).toBe(true);
    expect(extracted.values).toEqual({});
    expect(carrier).toEqual({});
  });

  it('uses explicitly selected adapter when registered', () => {
    registerAdapter({
      id: 'default',
      extract: (carrier) => ({ values: { traceparent: carrier.traceparent } }),
      inject: (context, carrier) => {
        const traceparent = context.values?.traceparent;
        if (typeof traceparent === 'string') {
          carrier.traceparent = traceparent;
        }
      }
    });

    const facade = createTelemetryFacade('default');
    const extracted = facade.extract({ traceparent: '00-abc-xyz-01' });
    const injected = facade.inject(extracted, {});

    expect(facade.isNoop).toBe(false);
    expect(extracted.values?.traceparent).toBe('00-abc-xyz-01');
    expect(injected.traceparent).toBe('00-abc-xyz-01');
  });

  it('falls back to registry-wide extraction/injection when selected adapter missing hooks', () => {
    registerAdapter({ id: 'default' });
    registerAdapter({
      id: 'secondary',
      extract: () => ({ values: { source: 'secondary' } }),
      inject: (_context, carrier) => {
        carrier.source = 'secondary';
      }
    });

    const facade = createTelemetryFacade('default');
    const context = facade.extract({});
    const carrier = facade.inject(context as TelemetryContext, {});

    expect(context.values?.source).toBe('secondary');
    expect(carrier.source).toBe('secondary');
  });
});
