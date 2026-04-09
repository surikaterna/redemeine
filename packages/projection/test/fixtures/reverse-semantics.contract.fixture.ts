import type {
  ReverseRelinkSpec,
  ReverseSubscribeSpec,
  ReverseUnsubscribeSpec,
  ReverseSemanticsWarning
} from '../../src/reverseSemanticsContract';

export const reverseSemanticsFixture = {
  subscribeMultiTarget: {
    aggregateType: 'order',
    aggregateId: 'order-1',
    targetDocIds: ['doc-a', 'doc-b', 'doc-a'] as const
  } satisfies ReverseSubscribeSpec,

  relinkRemoveAndAdd: {
    aggregateType: 'order',
    aggregateId: 'order-1',
    previousTargetDocIds: ['doc-a', 'doc-b'] as const,
    nextTargetDocIds: ['doc-b', 'doc-c'] as const,
    existingTargetDocIds: ['doc-a', 'doc-b'] as const
  } satisfies ReverseRelinkSpec,

  unsubscribeWarnAndSkip: {
    aggregateType: 'order',
    aggregateId: 'order-1',
    targetDocIds: ['doc-a', 'doc-missing'] as const,
    existingTargetDocIds: ['doc-a'] as const
  } satisfies Omit<ReverseUnsubscribeSpec, 'warn'>,

  createWarningSink(): {
    warnings: ReverseSemanticsWarning[];
    warn: (warning: ReverseSemanticsWarning) => void;
  } {
    const warnings: ReverseSemanticsWarning[] = [];
    return {
      warnings,
      warn(warning: ReverseSemanticsWarning) {
        warnings.push(warning);
      }
    };
  }
} as const;
