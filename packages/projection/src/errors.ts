/**
 * Thrown when a projection build fails due to missing configuration.
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
