declare const require: (id: string) => any;

const sagaPackage = require('@redemeine/saga');

export const createSagaDispatchContext = sagaPackage.createSagaDispatchContext as any;
export const runSagaHandler = sagaPackage.runSagaHandler as any;
export * from './createSagaAggregate';
