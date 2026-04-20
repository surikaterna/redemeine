export const contractTemplate = (aggregateName: string) => `import { z } from 'zod';

export const InitialState = {
  // Define initial state properties here
};

export const Commands = z.object({
  // Define your command schemas here
  // Command 'accept' will map to '${aggregateName}.accept.command'
  // Entity command 'orderLines.cancel' will map to '${aggregateName}.order_line.cancel.command'
});

export const Events = z.object({
  // IMPORTANT: Use the <aggregateName>.<key>.event naming convention
  // Example:
  // '${aggregateName}.created.event': z.object({
  //   payload: z.object({ /* ... */ })
  // })
});
`;

export const aggregateTemplate = (aggregateName: string) => `import { createAggregate, EntityArray } from '@redemeine/aggregate';
import { InitialState, Commands, Events } from './contract';
import * as selectors from './selectors';

export const ${aggregateName}Aggregate = createAggregate('${aggregateName}', InitialState)
  // .naming(namingStrategies.snakeCase) // Use for legacy demeine-compatible snake_case events
  // .extends(BaseAggregate) // Example of inheriting from another aggregate
  .commands(Commands)
  .events(Events)
  .entities({})
  .selectors(selectors);
`;

export const selectorsTemplate = () => `// Define your pluggable selectors here
export const getCoreState = (state: any) => state;
`;

export const entityTemplate = (entityName: string) => `import { createEntity } from '@redemeine/aggregate';

export const ${entityName}Entity = createEntity('${entityName}')
  .selectors({
    // Entity logic scoped and unpolluted from the root
  });
`;

export const aggregateSpecTemplate = (aggregateName: string) => `import { ${aggregateName}Aggregate } from './aggregate';

describe('${aggregateName} Aggregate', () => {
  const { process, apply, initialState } = ${aggregateName}Aggregate.build();

  it('should emit accepted event when accept command is processed', () => {
    // Given: Empty initial state
    const state = initialState;

    // When: Processing the accept command
    const events = process(state, { 
      type: '${aggregateName}.accept.command', 
      payload: { id: '123' } 
    } as any);

    // Then: Expect the correct targeted event name
    // expect(events[0]?.type).toBe('${aggregateName}.accepted.event');
  });
});
`;

export const testUtilsTemplate = () => `// Run the apply function over an array of events to reconstruct state
export function reduce(apply: (state: any, event: any) => any, initialState: any, events: any[]) {
  return events.reduce((state, event) => apply(state, event), initialState);
}
`;
