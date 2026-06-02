/**
 * Public entry point for `@redemeine/saga`.
 *
 * The exports below are grouped by their intended public API role. Some types
 * remain exported for aggregate-bridge and persisted-contract compatibility;
 * prefer the builder DSL and generated `.d.ts` types for new application code.
 *
 * @packageDocumentation
 */

// Builder DSL, plugin helper contracts, runtime execution helpers, and
// compatibility types used by saga definitions and aggregate event handlers.
export {
  createSaga,
  createSagaCommandsFor,
  createSagaDispatchContext,
  defineCustomAction,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin,
  runSagaErrorHandler,
  runSagaHandler,
  runSagaResponseHandler,
  type CreateSagaOptions,
  type RunSagaErrorHandlerInput,
  type RunSagaResponseHandlerInput,
  type SagaAggregateCommandEnvelope,
  type SagaAggregateDefinition,
  type SagaAggregateEventByName,
  type SagaAggregateEventName,
  type SagaAggregateEventPayloadMap,
  type SagaBuilder,
  type SagaCancelScheduleIntent,
  type SagaCommandCreators,
  type SagaCommandsFor,
  type SagaCorrelationFactory,
  type SagaDispatchIntentForCommand,
  type SagaDispatchTo,
  type SagaDefinition,
  type SagaErrorCallbackEnvelope,
  type SagaErrorTokenKey,
  type SagaRetryCallbackEnvelope,
  type SagaRetryTokenKey,
  type TErrorToken,
  type TRetryToken,
  type TResponseToken,
  type SagaExecutableErrorHandler,
  type SagaExecutableHandlerFailureReason,
  type SagaExecutableHandlerFailureResult,
  type SagaExecutableHandlerResult,
  type SagaExecutableHandlerSuccessResult,
  type SagaExecutableErrorHandlers,
  type SagaExecutableRetryHandler,
  type SagaExecutableRetryHandlers,
  type SagaExecutableResponseHandler,
  type SagaExecutableResponseHandlers,
  type SagaExternalHandlerRequestContext,
  type SagaHandler,
  type SagaHandlerResult,
  type SagaHandlers,
  type SagaInitialStateFactory,
  type SagaIntent,
  type SagaIntentContext,
  type SagaIntentContextBase,
  type SagaIdentityFields,
  type SagaIdentityMetadata,
  type SagaIntentMetadata,
  type SagaPluginActionArguments,
  type SagaPluginActionBuild,
  type SagaPluginActionDescriptor,
  type SagaPluginActionExecutionPayload,
  type SagaPluginActionNamesByInteraction,
  type SagaPluginActions,
  type SagaPluginActionsContext,
  type SagaPluginInteraction,
  type SagaPluginManifest,
  type SagaPluginManifestList,
  type SagaPluginIntent,
  type SagaIntentCompensationEntry,
  type SagaPluginOneWayIntentHandle,
  type SagaPluginOneWayIntent,
  type SagaPluginRegistryEntry,
  type SagaPluginRegistryEntryFromManifest,
  type SagaPluginRegistryFromManifests,
  type SagaRequestResponseActionDefinition,
  type SagaOneWayActionDefinition,
  type SagaPluginRequestIntent,
  type SagaPluginRequestIntentHandle,
  type SagaPluginRequestRoutingMetadata,
  type SagaPluginFireAndForgetActionDescriptor,
  type SagaPluginFireAndForgetActionNames,
  type SagaPluginRequestResponseActionDescriptor,
  type SagaPluginRequestResponseActionNames,
  type SagaCustomActionBuilderCtx,
  type SagaCustomActionPendingState,
  type SagaCustomOneWayActionDefinition,
  type SagaCustomRequestResponseActionDefinition,
  type SagaReducerOutput,
  type SagaResponseCallbackEnvelope,
  type SagaResponseHandlerPhase,
  type SagaResponseHandlerTokenAccess,
  type SagaResponseHandlerTokenBinding,
  type SagaResponseHandlerTokenBindings,
  type SagaResponseHandlerTokenNamespace,
  type SagaResponseTokenKey,
  type SagaScheduleIntent,
  type SagaStartCorrelationResolver,
  type SagaStartDslContracts,
  type SagaStartHandler,
  type SagaTriggerContract,
  type SagaTriggerDefinition
} from './createSaga';

// Start-policy DSL for controlling duplicate starts and restart semantics.
export {
  startPolicy,
  type SagaRestartMode,
  type SagaRestartOptions,
  type SagaStartPolicy,
  type SagaStartPolicyIfIdle,
  type SagaStartPolicyJoinExisting,
  type SagaStartPolicyRestart
} from './startPolicy';

// Trigger contracts shared between trigger builders and runtimes/schedulers.
export {
  type SagaSchedulerTriggerPolicyContract,
  type SagaTriggerMisfirePolicy,
  type SagaTriggerMisfirePolicyCatchUpAll,
  type SagaTriggerMisfirePolicyCatchUpBounded,
  type SagaTriggerMisfirePolicyLatestOnly,
  type SagaTriggerMisfirePolicySkipUntilNext,
  type SagaTriggerRestartPolicy,
  type SagaTriggerStartContract
} from './triggerContracts';

// Trigger builder DSL and schedule/event trigger definition contracts.
export {
  createSagaTriggerBuilder,
  type SagaCronScheduleInvocation,
  type SagaCronScheduleTriggerOptions,
  type SagaDirectTriggerDefinition,
  type SagaDirectTriggerOptions,
  type SagaEventTriggerDefinition,
  type SagaEventTriggerOptions,
  type SagaIntervalScheduleInvocation,
  type SagaIntervalScheduleTriggerOptions,
  type SagaIsoIntervalScheduleInvocation,
  type SagaIsoIntervalScheduleTriggerOptions,
  type SagaParentTriggerDefinition,
  type SagaParentTriggerOptions,
  type SagaRecoveryTriggerDefinition,
  type SagaRecoveryTriggerOptions,
  type SagaRRuleScheduleInvocation,
  type SagaRRuleScheduleTriggerOptions,
  type SagaScheduleAmbiguousTimePolicy,
  type SagaScheduleDstPolicy,
  type SagaScheduleInvocationBase,
  type SagaScheduleKind,
  type SagaScheduleMetadata,
  type SagaScheduleNonexistentTimePolicy,
  type SagaScheduleSemantics,
  type SagaScheduleTriggerDefinition,
  type SagaTriggerBuilderFactory,
  type SagaTriggerDefinitionBase,
  type SagaTriggerDefinitionBuilder,
  type SagaTriggerPredicate,
  type SagaTriggerToStartInput
} from './triggers';

// Aggregate bridge compatibility for existing aggregate-style integrations.
export { createAggregate } from './aggregateBridge';

// Saga identity utilities for canonical keys, URNs, and normalized metadata.
export {
  buildSagaType,
  normalizeSagaIdentity,
  SagaIdentityNormalizationError,
  deriveSagaInstanceUrn,
  deriveSagaUrn,
  parseSagaUrn,
  buildCanonicalSagaKey,
  buildCanonicalSagaInstanceUrn,
  buildCanonicalSagaType,
  buildCanonicalSagaUrn,
  normalizeSagaName,
  normalizeSagaNamespace,
  SAGA_NAME_PATTERN,
  SAGA_NAMESPACE_PATTERN,
  SAGA_URN_PREFIX,
  SAGA_VERSION_TOKEN_PATTERN,
  type SagaIdentityInput as CanonicalSagaIdentityInput,
  type SagaIdentityNormalizationErrorCode,
  type SagaIdentityParts,
  type NormalizedSagaIdentity,
  type SagaStructuredIdentity,
  type CanonicalSagaIdentityParts
} from './identity/index';

// Retry policy validation, classification, and scheduling helpers.
export {
  validateRetryPolicy,
  computeNextAttemptAt,
  isRetryableError,
  classifyRetryableError,
  type SagaRetryPolicy,
  type RetryableErrorClassification,
  type RetryableErrorPredicate,
  type RetryableErrorClassificationOptions,
  type RetrySchedulingNow
} from './RetryPolicy';
