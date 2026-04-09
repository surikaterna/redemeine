/**
 * Correlation storage used by .join and .reverseSubscribe routing.
 *
 * Stores source aggregate (type + id) -> target projection document id links.
 */
export interface IProjectionLinkStore {
  /**
   * Add or update correlation link for a source aggregate stream id.
   */
  addLink(sourceAggregateType: string, sourceAggregateId: string, targetDocumentId: string): void | Promise<void>;

  /**
   * Resolve target projection document id for a source aggregate stream id.
   */
  resolveTarget(sourceAggregateType: string, sourceAggregateId: string): string | null | Promise<string | null>;

  /**
   * Remove all links that point at a target document id.
   */
  removeLinksForTarget(targetDocumentId: string): void | Promise<void>;
}
