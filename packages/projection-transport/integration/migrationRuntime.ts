import { stackDefinitions, stackRuntimeIdentity } from './realStackFixtures';

export const migrationDefinitions = stackDefinitions().map((entry) => ({ ...entry, generation: 'v2' }));
export const migrationRuntimeIdentity = stackRuntimeIdentity('migration-new', 'v2');
