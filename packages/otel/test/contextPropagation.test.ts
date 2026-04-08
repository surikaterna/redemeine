import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  NOOP_TELEMETRY_CONTEXT,
  clearAdapters,
  extractContext,
  injectContext,
  registerAdapter,
  unregisterAdapter
} from '../src';

describe('context propagation helpers', () => {
  beforeEach(() => {
    clearAdapters();
  });

  it('returns NOOP context when no adapter extracts', () => {
    const context = extractContext({ traceparent: '00-abc-def-01' });

    expect(context).toBe(NOOP_TELEMETRY_CONTEXT);
    expect(context.values).toEqual({});
  });

  it('extracts from first adapter returning context', () => {
    registerAdapter({ id: 'first', extract: () => null });
    registerAdapter({ id: 'second', extract: () => ({ values: { spanId: 'span-123' } }) });

    const context = extractContext({});

    expect(context.values?.spanId).toBe('span-123');
  });

  it('injects context through all registered adapters', () => {
    registerAdapter({
      id: 'a',
      inject: (_context, carrier) => {
        carrier.a = '1';
      }
    });
    registerAdapter({
      id: 'b',
      inject: (_context, carrier) => {
        carrier.b = '2';
      }
    });

    const carrier = injectContext({ values: { traceId: 'trace-1' } }, {});

    expect(carrier).toEqual({ a: '1', b: '2' });
  });

  it('supports unregistering adapters', () => {
    registerAdapter({ id: 'temp', inject: (_context, carrier) => (carrier.temp = 'on') });
    unregisterAdapter('temp');

    const carrier = injectContext({ values: {} }, {});

    expect(carrier).toEqual({});
  });
});
