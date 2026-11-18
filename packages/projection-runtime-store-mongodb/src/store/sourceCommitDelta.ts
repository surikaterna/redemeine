import type { ProjectionChangePatchOperation, ProjectionChangeTarget } from '@redemeine/projection-runtime-core';
import { patch6902ToMongoUpdatePlan } from '../patch6902ToMongoUpdatePlan';

function isSafeMember(operation: ProjectionChangePatchOperation): boolean {
  if (!/^\/[a-zA-Z_][a-zA-Z0-9_]*$/.test(operation.path) || operation.path === '/__proto__') return false;
  return operation.op === 'remove' || operation.value === null || typeof operation.value !== 'object';
}

/** Called only after the patch has been replayed against the transaction's revision-checked snapshot. */
export function buildSourceCommitDelta<TState>(
  change: ProjectionChangeTarget | undefined,
  finalDocument: TState,
  metadata: Record<string, unknown>
): Record<string, unknown> | undefined {
  const [transition] = change?.transitions ?? [];
  if (change?.transitions.length !== 1 || transition?.changeType !== 'update') return undefined;
  const patch = transition.patch;
  if (!patch.every(isSafeMember) || new Set(patch.map(({ path }) => path)).size !== patch.length) return undefined;
  const plan = patch6902ToMongoUpdatePlan(patch, finalDocument);
  if (plan.mode !== 'compiled-update-document' || Object.keys(plan.push).length || Object.keys(plan.pop).length) return undefined;
  // Unique top-level scalar mutations cannot overlap. The transactional source CAS replaces planner guards.
  return {
    $set: { ...metadata, ...Object.fromEntries(Object.entries(plan.set).map(([path, value]) => [`state.${path}`, value])) },
    ...(plan.unset.length ? { $unset: Object.fromEntries(plan.unset.map((path) => [`state.${path}`, ''])) } : {})
  };
}
