import { deploymentDefinitions, runtimeDefinitions } from './migrationRuntimeDefinitions';

export const migrationDefinitions = runtimeDefinitions('v2');
export const migrationDeploymentDefinitions = deploymentDefinitions('v2');
