import { stackDefinitions } from './realStackFixtures';

export const migrationDefinitions = stackDefinitions().map((entry) => ({ ...entry, generation: 'v2' }));
