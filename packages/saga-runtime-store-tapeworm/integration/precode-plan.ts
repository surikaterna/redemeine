const indexName = 'vpwm_type_id';
const keyPattern = { 'events.type': 1, _id: 1 };
const wrappers = new Set(['FETCH', 'LIMIT', 'SKIP', 'PROJECTION_SIMPLE', 'PROJECTION_DEFAULT', 'SHARDING_FILTER']);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Unrecognized Mongo plan shape');
  return value as Record<string, unknown>;
}

function scan(node: unknown): string[] {
  const plan = record(node);
  if (plan.stage === 'IXSCAN') {
    if (plan.indexName !== indexName || JSON.stringify(plan.keyPattern) !== JSON.stringify(keyPattern)) {
      throw new Error(`Wrong intent index: ${String(plan.indexName)}`);
    }
    return [indexName];
  }
  if (plan.stage === 'COLLSCAN' || plan.stage === 'SORT' || plan.stage === 'SORT_KEY_GENERATOR') {
    throw new Error(`Blocking/collection stage: ${plan.stage}`);
  }
  if (typeof plan.stage !== 'string' || !wrappers.has(plan.stage) || !('inputStage' in plan)) {
    throw new Error(`Unrecognized Mongo plan stage: ${String(plan.stage)}`);
  }
  return scan(plan.inputStage);
}

export function inspectIntentExplain(explain: unknown) {
  const root = record(explain);
  const winning = record(record(root.queryPlanner).winningPlan);
  const shape = 'queryPlan' in winning && 'slotBasedPlan' in winning ? 'SBE' : 'classic';
  if (shape === 'classic' && ('queryPlan' in winning || 'slotBasedPlan' in winning)) {
    throw new Error('Unrecognized Mongo classic/SBE plan shape');
  }
  if (shape === 'SBE' && typeof record(winning.slotBasedPlan).stages !== 'string') {
    throw new Error('Unrecognized Mongo SBE plan shape');
  }
  const selected = scan(shape === 'SBE' ? winning.queryPlan : winning);
  if (selected.length !== 1) throw new Error('Expected one intent index scan');
  const stats = record(root.executionStats);
  const keys = stats.totalKeysExamined;
  const docs = stats.totalDocsExamined;
  const returned = stats.nReturned;
  if (typeof keys !== 'number' || typeof docs !== 'number' || typeof returned !== 'number'
    || ![keys, docs, returned].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Missing Mongo executionStats counts');
  }
  if (returned !== 64 || keys < returned || docs < returned || keys > 320 || docs > 160) {
    throw new Error(`Nonselective intent plan: keys=${keys}, docs=${docs}, returned=${returned}`);
  }
  return { shape, indexName, keyPattern, keysExamined: keys, docsExamined: docs,
    returned, keysPerReturned: keys / returned, docsPerReturned: docs / returned };
}
