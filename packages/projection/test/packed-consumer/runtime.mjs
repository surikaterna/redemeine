import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createProjection } from '@redemeine/projection';

const require = createRequire(import.meta.url);
assert.match(import.meta.resolve('@redemeine/projection'), /\/dist\/index\.js$/);
assert.match(require.resolve('@redemeine/projection'), /\/dist\/index\.cjs$/);

for (const create of [createProjection, require('@redemeine/projection').createProjection]) {
  const projection = create('packed-view', (id) => ({ id, count: 0 }))
    .from(
      { aggregateType: 'counter', pure: { eventProjectors: {} } },
      {
        incremented: (state) => {
          state.count += 1;
        }
      }
    )
    .build();
  const state = projection.initialState('one');
  projection.fromStream.handlers.incremented(state, { type: 'incremented', payload: {} }, {});
  assert.deepEqual(state, { id: 'one', count: 1 });
  assert.equal(projection.name, 'packed-view');
}
