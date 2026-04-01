export type SagaTriggerPredicate<TSource, TStartInput> = (
  source: Readonly<TSource>,
  startInput: Readonly<TStartInput>
) => boolean;

export type SagaTriggerToStartInput<TSource, TStartInput> = (
  source: Readonly<TSource>
) => TStartInput;

export interface SagaTriggerDefinitionBase<
  TFamily extends string,
  TSource,
  TStartInput,
  TWhen extends readonly SagaTriggerPredicate<TSource, TStartInput>[]
> {
  readonly family: TFamily;
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
  readonly when: TWhen;
}

type TriggerWhenListOf<TDefinition> =
  TDefinition extends { readonly when: infer TWhen extends readonly unknown[] }
    ? TWhen
    : readonly [];

type TriggerSourceOf<TDefinition> =
  TDefinition extends { readonly toStartInput: SagaTriggerToStartInput<infer TSource, any> }
    ? TSource
    : never;

type TriggerStartInputOf<TDefinition> =
  TDefinition extends { readonly toStartInput: SagaTriggerToStartInput<any, infer TStartInput> }
    ? TStartInput
    : never;

type WithAdditionalWhen<TDefinition, TPredicate> = Omit<TDefinition, 'when'> & {
  readonly when: readonly [...TriggerWhenListOf<TDefinition>, TPredicate];
};

export interface SagaTriggerDefinitionBuilder<TDefinition> {
  readonly definition: TDefinition;
  when<TPredicate extends SagaTriggerPredicate<TriggerSourceOf<TDefinition>, TriggerStartInputOf<TDefinition>>>(
    predicate: TPredicate
  ): SagaTriggerDefinitionBuilder<WithAdditionalWhen<TDefinition, TPredicate>>;
  build(): TDefinition;
}

function createSagaTriggerDefinitionBuilder<TDefinition extends { readonly when: readonly unknown[] }>(
  definition: TDefinition
): SagaTriggerDefinitionBuilder<TDefinition> {
  return {
    definition,
    when(predicate) {
      const nextWhen = [...definition.when, predicate] as unknown as readonly [
        ...TriggerWhenListOf<TDefinition>,
        typeof predicate
      ];

      const nextDefinition = {
        ...definition,
        when: nextWhen
      };

      return createSagaTriggerDefinitionBuilder(nextDefinition);
    },
    build() {
      return definition;
    }
  };
}

export interface SagaEventTriggerDefinition<
  TSource,
  TStartInput,
  TWhen extends readonly SagaTriggerPredicate<TSource, TStartInput>[] = readonly []
> extends SagaTriggerDefinitionBase<'event', TSource, TStartInput, TWhen> {
  readonly event: string;
}

export interface SagaParentTriggerDefinition<
  TSource,
  TStartInput,
  TWhen extends readonly SagaTriggerPredicate<TSource, TStartInput>[] = readonly []
> extends SagaTriggerDefinitionBase<'parent', TSource, TStartInput, TWhen> {
  readonly parent: {
    readonly allowList?: readonly string[];
    readonly requiredCapability?: string;
  };
}

export interface SagaDirectTriggerDefinition<
  TSource,
  TStartInput,
  TWhen extends readonly SagaTriggerPredicate<TSource, TStartInput>[] = readonly []
> extends SagaTriggerDefinitionBase<'direct', TSource, TStartInput, TWhen> {
  readonly direct: {
    readonly channel?: string;
  };
}

export interface SagaRecoveryTriggerDefinition<
  TSource,
  TStartInput,
  TWhen extends readonly SagaTriggerPredicate<TSource, TStartInput>[] = readonly []
> extends SagaTriggerDefinitionBase<'recovery', TSource, TStartInput, TWhen> {
  readonly recovery: {
    readonly reason?: string;
  };
}

export type SagaScheduleKind = 'interval' | 'cron' | 'rrule' | 'isoInterval';
export type SagaScheduleSemantics = 'elapsed-time' | 'wall-clock';
export type SagaScheduleAmbiguousTimePolicy = 'first-occurrence-only';
export type SagaScheduleNonexistentTimePolicy = 'next-valid-time';

export interface SagaScheduleDstPolicy {
  readonly ambiguousTime: SagaScheduleAmbiguousTimePolicy;
  readonly nonexistentTime: SagaScheduleNonexistentTimePolicy;
}

export interface SagaScheduleMetadata<TSemantics extends SagaScheduleSemantics> {
  readonly semantics: TSemantics;
  readonly dstPolicy: SagaScheduleDstPolicy;
}

export interface SagaScheduleInvocationBase<TKind extends SagaScheduleKind> {
  readonly kind: TKind;
  readonly occurrenceId: string;
  readonly scheduledFor: string;
}

export interface SagaIntervalScheduleInvocation
  extends SagaScheduleInvocationBase<'interval'> {
  readonly everyMs: number;
}

export interface SagaIsoIntervalScheduleInvocation
  extends SagaScheduleInvocationBase<'isoInterval'> {
  readonly isoInterval: string;
}

export interface SagaCronScheduleInvocation
  extends SagaScheduleInvocationBase<'cron'> {
  readonly cron: string;
  readonly timezone: string;
}

export interface SagaRRuleScheduleInvocation
  extends SagaScheduleInvocationBase<'rrule'> {
  readonly rrule: string;
  readonly timezone: string;
}

export interface SagaScheduleTriggerDefinition<
  TKind extends SagaScheduleKind,
  TSource,
  TStartInput,
  TSemantics extends SagaScheduleSemantics,
  TWhen extends readonly SagaTriggerPredicate<TSource, TStartInput>[] = readonly []
> extends SagaTriggerDefinitionBase<'schedule', TSource, TStartInput, TWhen> {
  readonly schedule: {
    readonly kind: TKind;
    readonly metadata: SagaScheduleMetadata<TSemantics>;
    readonly everyMs?: number;
    readonly isoInterval?: string;
    readonly cron?: string;
    readonly rrule?: string;
    readonly timezone?: string;
  };
}

export interface SagaEventTriggerOptions<TSource, TStartInput> {
  readonly event: string;
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
}

export interface SagaParentTriggerOptions<TSource, TStartInput> {
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
  readonly allowList?: readonly string[];
  readonly requiredCapability?: string;
}

export interface SagaDirectTriggerOptions<TSource, TStartInput> {
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
  readonly channel?: string;
}

export interface SagaRecoveryTriggerOptions<TSource, TStartInput> {
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
  readonly reason?: string;
}

export interface SagaIntervalScheduleTriggerOptions<
  TSource extends SagaIntervalScheduleInvocation,
  TStartInput
> {
  readonly everyMs: number;
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
}

export interface SagaIsoIntervalScheduleTriggerOptions<
  TSource extends SagaIsoIntervalScheduleInvocation,
  TStartInput
> {
  readonly isoInterval: string;
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
}

export interface SagaCronScheduleTriggerOptions<
  TSource extends SagaCronScheduleInvocation,
  TStartInput
> {
  readonly cron: string;
  readonly timezone: string;
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
}

export interface SagaRRuleScheduleTriggerOptions<
  TSource extends SagaRRuleScheduleInvocation,
  TStartInput
> {
  readonly rrule: string;
  readonly timezone: string;
  readonly toStartInput: SagaTriggerToStartInput<TSource, TStartInput>;
}

const DEFAULT_SCHEDULE_DST_POLICY: SagaScheduleDstPolicy = {
  ambiguousTime: 'first-occurrence-only',
  nonexistentTime: 'next-valid-time'
};

function createElapsedTimeMetadata(): SagaScheduleMetadata<'elapsed-time'> {
  return {
    semantics: 'elapsed-time',
    dstPolicy: DEFAULT_SCHEDULE_DST_POLICY
  };
}

function createWallClockMetadata(): SagaScheduleMetadata<'wall-clock'> {
  return {
    semantics: 'wall-clock',
    dstPolicy: DEFAULT_SCHEDULE_DST_POLICY
  };
}

export interface SagaTriggerBuilderFactory<TStartInput> {
  event<TSource>(
    options: SagaEventTriggerOptions<TSource, TStartInput>
  ): SagaTriggerDefinitionBuilder<SagaEventTriggerDefinition<TSource, TStartInput>>;
  parent<TSource>(
    options: SagaParentTriggerOptions<TSource, TStartInput>
  ): SagaTriggerDefinitionBuilder<SagaParentTriggerDefinition<TSource, TStartInput>>;
  direct<TSource>(
    options: SagaDirectTriggerOptions<TSource, TStartInput>
  ): SagaTriggerDefinitionBuilder<SagaDirectTriggerDefinition<TSource, TStartInput>>;
  recovery<TSource>(
    options: SagaRecoveryTriggerOptions<TSource, TStartInput>
  ): SagaTriggerDefinitionBuilder<SagaRecoveryTriggerDefinition<TSource, TStartInput>>;
  readonly schedule: {
    interval<TSource extends SagaIntervalScheduleInvocation = SagaIntervalScheduleInvocation>(
      options: SagaIntervalScheduleTriggerOptions<TSource, TStartInput>
    ): SagaTriggerDefinitionBuilder<SagaScheduleTriggerDefinition<'interval', TSource, TStartInput, 'elapsed-time'>>;
    isoInterval<TSource extends SagaIsoIntervalScheduleInvocation = SagaIsoIntervalScheduleInvocation>(
      options: SagaIsoIntervalScheduleTriggerOptions<TSource, TStartInput>
    ): SagaTriggerDefinitionBuilder<SagaScheduleTriggerDefinition<'isoInterval', TSource, TStartInput, 'elapsed-time'>>;
    cron<TSource extends SagaCronScheduleInvocation = SagaCronScheduleInvocation>(
      options: SagaCronScheduleTriggerOptions<TSource, TStartInput>
    ): SagaTriggerDefinitionBuilder<SagaScheduleTriggerDefinition<'cron', TSource, TStartInput, 'wall-clock'>>;
    rrule<TSource extends SagaRRuleScheduleInvocation = SagaRRuleScheduleInvocation>(
      options: SagaRRuleScheduleTriggerOptions<TSource, TStartInput>
    ): SagaTriggerDefinitionBuilder<SagaScheduleTriggerDefinition<'rrule', TSource, TStartInput, 'wall-clock'>>;
  };
}

/**
 * Definition-only trigger DSL for mapping trigger source payloads into saga StartInput.
 */
export function createSagaTriggerBuilder<TStartInput>(): SagaTriggerBuilderFactory<TStartInput> {
  return {
    event: <TSource>(options: SagaEventTriggerOptions<TSource, TStartInput>) => createSagaTriggerDefinitionBuilder({
      family: 'event',
      event: options.event,
      toStartInput: options.toStartInput,
      when: [] as const
    }),
    parent: <TSource>(options: SagaParentTriggerOptions<TSource, TStartInput>) => createSagaTriggerDefinitionBuilder({
      family: 'parent',
      parent: {
        allowList: options.allowList,
        requiredCapability: options.requiredCapability
      },
      toStartInput: options.toStartInput,
      when: [] as const
    }),
    direct: <TSource>(options: SagaDirectTriggerOptions<TSource, TStartInput>) => createSagaTriggerDefinitionBuilder({
      family: 'direct',
      direct: {
        channel: options.channel
      },
      toStartInput: options.toStartInput,
      when: [] as const
    }),
    recovery: <TSource>(options: SagaRecoveryTriggerOptions<TSource, TStartInput>) => createSagaTriggerDefinitionBuilder({
      family: 'recovery',
      recovery: {
        reason: options.reason
      },
      toStartInput: options.toStartInput,
      when: [] as const
    }),
    schedule: {
      interval: <TSource extends SagaIntervalScheduleInvocation>(
        options: SagaIntervalScheduleTriggerOptions<TSource, TStartInput>
      ) => createSagaTriggerDefinitionBuilder({
        family: 'schedule',
        schedule: {
          kind: 'interval',
          everyMs: options.everyMs,
          metadata: createElapsedTimeMetadata()
        },
        toStartInput: options.toStartInput,
        when: [] as const
      }),
      isoInterval: <TSource extends SagaIsoIntervalScheduleInvocation>(
        options: SagaIsoIntervalScheduleTriggerOptions<TSource, TStartInput>
      ) => createSagaTriggerDefinitionBuilder({
        family: 'schedule',
        schedule: {
          kind: 'isoInterval',
          isoInterval: options.isoInterval,
          metadata: createElapsedTimeMetadata()
        },
        toStartInput: options.toStartInput,
        when: [] as const
      }),
      cron: <TSource extends SagaCronScheduleInvocation>(
        options: SagaCronScheduleTriggerOptions<TSource, TStartInput>
      ) => createSagaTriggerDefinitionBuilder({
        family: 'schedule',
        schedule: {
          kind: 'cron',
          cron: options.cron,
          timezone: options.timezone,
          metadata: createWallClockMetadata()
        },
        toStartInput: options.toStartInput,
        when: [] as const
      }),
      rrule: <TSource extends SagaRRuleScheduleInvocation>(
        options: SagaRRuleScheduleTriggerOptions<TSource, TStartInput>
      ) => createSagaTriggerDefinitionBuilder({
        family: 'schedule',
        schedule: {
          kind: 'rrule',
          rrule: options.rrule,
          timezone: options.timezone,
          metadata: createWallClockMetadata()
        },
        toStartInput: options.toStartInput,
        when: [] as const
      })
    }
  };
}
