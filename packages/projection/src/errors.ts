/**
 * Thrown when a projection cannot be built due to missing required configuration.
 *
 * Typically indicates a missing `.from()` stream or `.initialState()` definition.
 *
 * @since 0.1.0
 */
export class ProjectionBuildError extends Error {
  public readonly projectionName: string;
  public readonly missingFields: readonly string[];

  constructor(
    projectionName: string,
    missingFields: readonly string[],
    options?: ErrorOptions
  ) {
    super(`Projection "${projectionName}" build failed: missing ${missingFields.join(', ')}`, options);
    this.name = 'ProjectionBuildError';
    this.projectionName = projectionName;
    this.missingFields = missingFields;
  }
}
