import { describe, expect, it } from '@jest/globals';
import { createProjection } from '../../projection/src';
import { testProjection } from '../src/testProjection';
import type { TestProjectionEvent } from '../src/testProjection';

const invoiceAgg = {
  __aggregateType: 'invoice' as const,
  pure: {
    eventProjectors: {
      created: (_state: unknown, event: { payload: { invoiceId: string; orderId: string; amount: number } }) => {
        void event;
      }
    }
  }
};

const orderAgg = {
  __aggregateType: 'order' as const,
  pure: {
    eventProjectors: {
      shipped: (_state: unknown, event: { payload: { orderId: string; carrier: string } }) => {
        void event;
      }
    }
  }
};

type InvoiceSummary = {
  total: number;
  invoiceIds: string[];
  shipments: string[];
};

describe('testProjection fixture', () => {
  it('applies .from handler and returns exact patch order', () => {
    const projection = createProjection<InvoiceSummary>('invoice-summary', () => ({
      total: 0,
      invoiceIds: [],
      shipments: []
    }))
      .from(invoiceAgg, {
        created: (state, event, ctx) => {
          state.total += event.payload.amount;
          state.invoiceIds.push(event.payload.invoiceId);
          ctx.subscribeTo(orderAgg, event.payload.orderId);
        }
      })
      .join(orderAgg, {
        shipped: (state, event) => {
          state.shipments.push(`${event.payload.orderId}:${event.payload.carrier}`);
        }
      })
      .build();

    const fixture = testProjection(projection).withState({
      total: 0,
      invoiceIds: [],
      shipments: []
    });

    const createdEvent: TestProjectionEvent = {
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      type: 'invoice.created.event',
      payload: {
        invoiceId: 'inv-1',
        orderId: 'ord-1',
        amount: 125
      },
      sequence: 1,
      timestamp: '2026-04-02T00:00:00.000Z'
    };

    const result = fixture.applyEvent(createdEvent);

    expect(result.state).toEqual({
      total: 125,
      invoiceIds: ['inv-1'],
      shipments: []
    });

    expect(result.patches).toEqual([
      { op: 'add', path: ['invoiceIds', 0], value: 'inv-1' },
      { op: 'replace', path: ['total'], value: 125 }
    ]);
  });

  it('applies .join handler and preserves patch order', () => {
    const projection = createProjection<InvoiceSummary>('invoice-summary', () => ({
      total: 0,
      invoiceIds: [],
      shipments: []
    }))
      .from(invoiceAgg, {
        created: (state, event) => {
          state.total += event.payload.amount;
        }
      })
      .join(orderAgg, {
        shipped: (state, event) => {
          state.shipments.push(event.payload.orderId);
          state.shipments.push(event.payload.carrier);
        }
      })
      .build();

    const fixture = testProjection(projection).withState({
      total: 125,
      invoiceIds: ['inv-1'],
      shipments: []
    });

    const shippedEvent: TestProjectionEvent = {
      aggregateType: 'order',
      aggregateId: 'ord-1',
      type: 'shipped',
      payload: {
        orderId: 'ord-1',
        carrier: 'post'
      },
      sequence: 2,
      timestamp: '2026-04-02T00:00:01.000Z'
    };

    const result = fixture.applyEvent(shippedEvent);

    expect(result.state).toEqual({
      total: 125,
      invoiceIds: ['inv-1'],
      shipments: ['ord-1', 'post']
    });

    expect(result.patches).toEqual([
      { op: 'add', path: ['shipments', 0], value: 'ord-1' },
      { op: 'add', path: ['shipments', 1], value: 'post' }
    ]);
  });
});
