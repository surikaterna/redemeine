/**
 * Typed start-policy variants used by saga trigger contracts.
 */
export type SagaStartPolicy = SagaStartPolicyIfIdle | SagaStartPolicyJoinExisting | SagaStartPolicyRestart;

export interface SagaStartPolicyIfIdle {
  readonly type: 'if-idle';
}

export interface SagaStartPolicyJoinExisting {
  readonly type: 'join-existing';
}

export type SagaRestartMode = 'graceful' | 'force';

export interface SagaRestartOptions {
  /**
   * Optional restart mode for trigger/runtime integrations.
   *
   * This is definition-only and does not alter runtime behavior in this layer.
   */
  readonly mode?: SagaRestartMode;
  readonly reason?: string;
}

export interface SagaStartPolicyRestart {
  readonly type: 'restart';
  readonly options?: SagaRestartOptions;
}

/**
 * Public helper API for constructing typed start policies without magic strings.
 */
export const startPolicy = {
  ifIdle(): SagaStartPolicyIfIdle {
    return { type: 'if-idle' };
  },

  joinExisting(): SagaStartPolicyJoinExisting {
    return { type: 'join-existing' };
  },

  restart(options?: SagaRestartOptions): SagaStartPolicyRestart {
    return {
      type: 'restart',
      options
    };
  }
} as const;
