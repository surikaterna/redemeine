import type { Checkpoint } from '../types';

export type ProjectionRebuildGenerationId = string;

export type ProjectionRebuildLifecycleStatus =
  | 'shadow_building'
  | 'shadow_ready'
  | 'live'
  | 'rollback_ready'
  | 'rolled_back';

export interface ProjectionCutoverReadinessCriteria {
  shadowCaughtUp: boolean;
  validationPassed: boolean;
  writesQuiesced: boolean;
}

export interface ProjectionCutoverReadiness {
  ready: boolean;
  unmetCriteria: Array<keyof ProjectionCutoverReadinessCriteria>;
}

export interface ProjectionRebuildLifecycleState {
  activeGenerationId: ProjectionRebuildGenerationId;
  shadowGenerationId: ProjectionRebuildGenerationId;
  status: ProjectionRebuildLifecycleStatus;
  checkpoint?: Checkpoint;
}

export interface ProjectionCutoverRequest {
  state: ProjectionRebuildLifecycleState;
  readiness: ProjectionCutoverReadinessCriteria;
  checkpoint: Checkpoint;
}

export interface ProjectionRollbackRequest {
  state: ProjectionRebuildLifecycleState;
  checkpoint: Checkpoint;
}

export interface ProjectionGenerationCutoverContract {
  cutover(request: ProjectionCutoverRequest): Promise<ProjectionRebuildLifecycleState>;
}

export interface ProjectionGenerationRollbackContract {
  rollback(request: ProjectionRollbackRequest): Promise<ProjectionRebuildLifecycleState>;
}

export interface ProjectionGenerationSwitchContract
  extends ProjectionGenerationCutoverContract, ProjectionGenerationRollbackContract {}

export function evaluateCutoverReadiness(
  criteria: ProjectionCutoverReadinessCriteria
): ProjectionCutoverReadiness {
  const unmetCriteria = (Object.entries(criteria) as Array<[keyof ProjectionCutoverReadinessCriteria, boolean]>)
    .filter(([, satisfied]) => !satisfied)
    .map(([key]) => key);

  return {
    ready: unmetCriteria.length === 0,
    unmetCriteria
  };
}

export function transitionToCutover(
  request: ProjectionCutoverRequest
): ProjectionRebuildLifecycleState {
  const readiness = evaluateCutoverReadiness(request.readiness);
  if (!readiness.ready) {
    return request.state;
  }

  if (request.state.status !== 'shadow_ready' && request.state.status !== 'rollback_ready') {
    return request.state;
  }

  return {
    activeGenerationId: request.state.shadowGenerationId,
    shadowGenerationId: request.state.activeGenerationId,
    status: 'live',
    checkpoint: request.checkpoint
  };
}

export function transitionToRollback(
  request: ProjectionRollbackRequest
): ProjectionRebuildLifecycleState {
  if (request.state.status !== 'rollback_ready') {
    return request.state;
  }

  return {
    activeGenerationId: request.state.shadowGenerationId,
    shadowGenerationId: request.state.activeGenerationId,
    status: 'rolled_back',
    checkpoint: request.checkpoint
  };
}
