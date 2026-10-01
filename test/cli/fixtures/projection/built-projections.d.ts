import type { ProjectionDefinition, ProjectionCommitDefinition } from '../../../../packages/projection/src';
import type { ProjectionDefinition as RuntimeDefinition } from '../../../../packages/projection-runtime-core/src';

export declare const publicDefinition: ProjectionDefinition<{ built: boolean }>;
export declare const runtimeDefinition: RuntimeDefinition<{ built: string }>;
export declare const commitDefinition: ProjectionCommitDefinition<{ built: number }>;
