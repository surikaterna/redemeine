export type ProjectionPoisonClass = 'malformed' | 'garbage' | 'binary' | 'oversized';

export type ProjectionPoisonHandlingAction = 'drop' | 'dead-letter' | 'retry' | 'quarantine';

export type ProjectionPoisonClassificationModel = Readonly<
  Record<ProjectionPoisonClass, ProjectionPoisonHandlingAction>
>;

export const DEFAULT_PROJECTION_POISON_CLASSIFICATION_MODEL: ProjectionPoisonClassificationModel = {
  malformed: 'dead-letter',
  garbage: 'drop',
  binary: 'quarantine',
  oversized: 'retry'
};

export interface ProjectionEnvelopeValidationCandidate {
  payloadBytes: number;
  maxPayloadBytes: number;
  parseable: boolean;
  binary: boolean;
  envelopeShapeValid: boolean;
}

export interface ProjectionEnvelopeValidValidationResult {
  status: 'valid';
}

export interface ProjectionEnvelopePoisonValidationResult {
  status: 'poison';
  poisonClass: ProjectionPoisonClass;
  action: ProjectionPoisonHandlingAction;
}

export type ProjectionEnvelopeValidationResult =
  | ProjectionEnvelopeValidValidationResult
  | ProjectionEnvelopePoisonValidationResult;

export interface ProjectionEnvelopeValidator {
  validate(candidate: ProjectionEnvelopeValidationCandidate): ProjectionEnvelopeValidationResult;
}

export interface ProjectionPoisonClassifier {
  classify(poisonClass: ProjectionPoisonClass): ProjectionPoisonHandlingAction;
}

export function classifyProjectionEnvelopeCandidate(
  candidate: ProjectionEnvelopeValidationCandidate,
  model: ProjectionPoisonClassificationModel = DEFAULT_PROJECTION_POISON_CLASSIFICATION_MODEL
): ProjectionEnvelopeValidationResult {
  if (candidate.binary) {
    return {
      status: 'poison',
      poisonClass: 'binary',
      action: model.binary
    };
  }

  if (candidate.payloadBytes > candidate.maxPayloadBytes) {
    return {
      status: 'poison',
      poisonClass: 'oversized',
      action: model.oversized
    };
  }

  if (!candidate.parseable) {
    return {
      status: 'poison',
      poisonClass: 'garbage',
      action: model.garbage
    };
  }

  if (!candidate.envelopeShapeValid) {
    return {
      status: 'poison',
      poisonClass: 'malformed',
      action: model.malformed
    };
  }

  return { status: 'valid' };
}
