import type { ProjectionDefinition } from '@redemeine/projection';
import { createProjection } from '@redemeine/projection';

export const projection = createProjection('packed-view', (id: string) => ({ id, count: 0 }))
  .from(
    { aggregateType: 'counter', pure: { eventProjectors: {} } },
    {
      incremented: (state) => {
        state.count += 1;
      }
    }
  )
  .build();

const definition: ProjectionDefinition<{ id: string; count: number }> = projection;
const count: number = definition.initialState('one').count;
void count;
