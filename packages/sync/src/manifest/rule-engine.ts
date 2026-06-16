import type { LaneSelector } from './selectors';

// ---------------------------------------------------------------------------
// Rule context — input to the rule engine
// ---------------------------------------------------------------------------

/**
 * Context provided to the rule engine when evaluating which selectors
 * should be active for a given node. The `domainState` is opaque —
 * the framework never interprets it; the consumer's rule engine does.
 */
export interface RuleContext {
  /** Target downstream node identifier. */
  readonly nodeId: string;

  /** Tenant identifier for multi-tenant deployments. */
  readonly tenant: string;

  /** ISO-8601 timestamp of the evaluation moment. */
  readonly timestamp: string;

  /** Opaque domain state provided by the consumer — the framework never inspects this. */
  readonly domainState: unknown;
}

// ---------------------------------------------------------------------------
// Rule engine interface — pluggable adapter contract
// ---------------------------------------------------------------------------

/**
 * Pluggable rule engine that produces lane selectors for a downstream node.
 *
 * Consumers implement this interface to encode their business rules for
 * what data each node should receive. The framework calls `evaluate` during
 * manifest recomputation and uses the returned selectors to build the manifest.
 */
export interface IManifestRuleEngine {
  /**
   * Evaluate rules for the given context and return the set of selectors
   * that should be active for the target node.
   */
  evaluate(context: RuleContext): Promise<ReadonlyArray<LaneSelector>>;
}
