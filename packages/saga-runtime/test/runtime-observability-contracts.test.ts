import { describe, expect, it } from '@jest/globals';
import type {
  RuntimeAuditQuery,
  RuntimeAuditQueryResult,
  RuntimeAuditRecord,
  RuntimeIntentExecutionQuery,
  RuntimeIntentExecutionQueryResult,
  RuntimeObservabilityReadApiContract,
  RuntimeReadModelContract,
  RuntimeTelemetryRecord
} from '../src';

describe('runtime observability/read API contracts', () => {
  it('captures telemetry lifecycle payload shape', () => {
    const telemetryRecord: RuntimeTelemetryRecord = {
      kind: 'intent.execution',
      level: 'info',
      occurredAt: '2026-01-01T00:00:00.000Z',
      message: 'intent execution status advanced',
      context: {
        sagaId: 'saga-123',
        intentId: 'intent-42',
        executionId: 'exec-7',
        correlationId: 'corr-1',
        sequence: 9
      },
      attributes: {
        status: 'in_progress',
        attempt: 2
      }
    };

    expect(telemetryRecord.kind).toBe('intent.execution');
    expect(telemetryRecord.level).toBe('info');
    expect(telemetryRecord.context.executionId).toBe('exec-7');
  });

  it('captures audit write and read query shapes', () => {
    const auditRecord: RuntimeAuditRecord = {
      auditId: 'audit-100',
      category: 'event',
      action: 'saga.state_transitioned.event',
      recordedAt: '2026-01-01T00:00:01.000Z',
      sagaId: 'saga-123',
      intentExecutionId: 'exec-7',
      references: [
        { type: 'saga', id: 'saga-123', version: 5 },
        { type: 'intent_execution', id: 'exec-7' }
      ],
      metadata: {
        source: 'runtime'
      }
    };

    const query: RuntimeAuditQuery = {
      sagaId: 'saga-123',
      categories: ['event', 'projection'],
      limit: 50,
      cursor: {
        recordedAt: '2026-01-01T00:00:00.000Z',
        auditId: 'audit-99'
      }
    };

    const queryResult: RuntimeAuditQueryResult = {
      items: [auditRecord],
      nextCursor: {
        recordedAt: '2026-01-01T00:00:01.000Z',
        auditId: 'audit-100'
      },
      totalApproximate: 1
    };

    expect(query.categories).toEqual(['event', 'projection']);
    expect(queryResult.items[0]?.references?.[0]?.type).toBe('saga');
    expect(queryResult.nextCursor?.auditId).toBe('audit-100');
  });

  it('captures read-model contract method signatures and response shapes', async () => {
    const readModel: RuntimeReadModelContract = {
      getSagaById: (_id, _options) => null,
      getIntentExecutionById: (_id) => null,
      queryIntentExecutions: (_query) => ({
        items: [],
        nextCursor: 'cursor-2'
      })
    };

    const query: RuntimeIntentExecutionQuery = {
      sagaId: 'saga-123',
      statuses: ['in_progress', 'failed'],
      limit: 25,
      cursor: 'cursor-1'
    };

    const result = (await readModel.queryIntentExecutions(query)) as RuntimeIntentExecutionQueryResult;

    expect(query.statuses).toEqual(['in_progress', 'failed']);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBe('cursor-2');
  });

  it('composes telemetry, audit, and read model contracts in runtime API surface', () => {
    const contract: RuntimeObservabilityReadApiContract = {
      telemetry: {
        publish: () => undefined
      },
      audit: {
        append: () => undefined,
        query: () => ({ items: [] }),
        getByAuditId: () => null
      },
      readModel: {
        getSagaById: () => null,
        getIntentExecutionById: () => null,
        queryIntentExecutions: () => ({ items: [] })
      }
    };

    expect(typeof contract.telemetry.publish).toBe('function');
    expect(typeof contract.audit.query).toBe('function');
    expect(typeof contract.readModel.queryIntentExecutions).toBe('function');
  });
});
