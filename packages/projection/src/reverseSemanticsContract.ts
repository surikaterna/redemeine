export interface ReverseLinkAddress {
  aggregateType: string;
  aggregateId: string;
  targetDocId: string;
}

export type ReverseMutation =
  | { op: 'remove'; link: ReverseLinkAddress }
  | { op: 'add'; link: ReverseLinkAddress };

export interface ReverseSemanticsWarning {
  code: 'missing_target';
  aggregateType: string;
  aggregateId: string;
  targetDocId: string;
  message: string;
}

export interface ReverseSubscribeSpec {
  aggregateType: string;
  aggregateId: string;
  targetDocIds: string | readonly string[];
}

export interface ReverseRelinkSpec {
  aggregateType: string;
  aggregateId: string;
  previousTargetDocIds: string | readonly string[];
  nextTargetDocIds: string | readonly string[];
  existingTargetDocIds?: string | readonly string[];
  warn?: (warning: ReverseSemanticsWarning) => void;
}

export interface ReverseUnsubscribeSpec {
  aggregateType: string;
  aggregateId: string;
  targetDocIds: string | readonly string[];
  existingTargetDocIds?: string | readonly string[];
  warn?: (warning: ReverseSemanticsWarning) => void;
}

/**
 * Contract helper for reverseSubscribe semantics.
 *
 * Supports one or many target documents and normalizes duplicates.
 */
export function planReverseSubscribe(spec: ReverseSubscribeSpec): ReverseMutation[] {
  const targets = normalizeTargetDocIds(spec.targetDocIds);
  return targets.map((targetDocId) => ({
    op: 'add' as const,
    link: {
      aggregateType: spec.aggregateType,
      aggregateId: spec.aggregateId,
      targetDocId
    }
  }));
}

/**
 * Contract helper for relink semantics.
 *
 * Relink is explicit remove + add only.
 * A replace operation is intentionally not part of this contract.
 */
export function planReverseRelink(spec: ReverseRelinkSpec): ReverseMutation[] {
  const previous = normalizeTargetDocIds(spec.previousTargetDocIds);
  const next = normalizeTargetDocIds(spec.nextTargetDocIds);
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  const existingSet = spec.existingTargetDocIds
    ? new Set(normalizeTargetDocIds(spec.existingTargetDocIds))
    : null;

  const removals: ReverseMutation[] = [];
  const additions: ReverseMutation[] = [];

  for (const targetDocId of previous) {
    if (nextSet.has(targetDocId)) {
      continue;
    }

    if (existingSet && !existingSet.has(targetDocId)) {
      warnMissingTarget(spec, targetDocId);
      continue;
    }

    removals.push({
      op: 'remove',
      link: {
        aggregateType: spec.aggregateType,
        aggregateId: spec.aggregateId,
        targetDocId
      }
    });
  }

  for (const targetDocId of next) {
    if (previousSet.has(targetDocId)) {
      continue;
    }

    additions.push({
      op: 'add',
      link: {
        aggregateType: spec.aggregateType,
        aggregateId: spec.aggregateId,
        targetDocId
      }
    });
  }

  return [...removals, ...additions];
}

/**
 * Contract helper for reverse unsubscribe semantics.
 *
 * Missing targets are warn-and-skip.
 */
export function planReverseUnsubscribe(spec: ReverseUnsubscribeSpec): ReverseMutation[] {
  const targets = normalizeTargetDocIds(spec.targetDocIds);
  const existingSet = spec.existingTargetDocIds
    ? new Set(normalizeTargetDocIds(spec.existingTargetDocIds))
    : null;

  const removals: ReverseMutation[] = [];

  for (const targetDocId of targets) {
    if (existingSet && !existingSet.has(targetDocId)) {
      warnMissingTarget(spec, targetDocId);
      continue;
    }

    removals.push({
      op: 'remove',
      link: {
        aggregateType: spec.aggregateType,
        aggregateId: spec.aggregateId,
        targetDocId
      }
    });
  }

  return removals;
}

function normalizeTargetDocIds(targetDocIds: string | readonly string[]): string[] {
  const raw = Array.isArray(targetDocIds) ? targetDocIds : [targetDocIds];
  const normalized = raw
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return Array.from(new Set(normalized));
}

function warnMissingTarget(
  spec:
    | Pick<ReverseRelinkSpec, 'aggregateType' | 'aggregateId' | 'warn'>
    | Pick<ReverseUnsubscribeSpec, 'aggregateType' | 'aggregateId' | 'warn'>,
  targetDocId: string
): void {
  spec.warn?.({
    code: 'missing_target',
    aggregateType: spec.aggregateType,
    aggregateId: spec.aggregateId,
    targetDocId,
    message: `Reverse mutation skipped: no existing target '${targetDocId}' for ${spec.aggregateType}:${spec.aggregateId}`
  });
}
