declare const require: (id: string) => any;

const aggregateBridge = require('../../../src/createAggregate') as {
  createAggregate: (name: string, initialState: unknown) => any;
};

export const createAggregate = aggregateBridge.createAggregate;
