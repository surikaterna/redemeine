export const contractTemplate = (_name: string) => `import { z } from 'zod';

export const StateSchema = z.object({ id: z.string(), accepted: z.boolean() });
export type State = z.infer<typeof StateSchema>;
export const InitialState: State = { id: '', accepted: false };
export const AcceptSchema = z.object({ id: z.string().min(1) });
export type Accept = z.infer<typeof AcceptSchema>;
`;

export const aggregateTemplate = (name: string, entities: readonly string[] = []) => `import { createAggregate as _createAggregate } from '@redemeine/aggregate';
import type { Event as _Event } from '@redemeine/kernel';
import { InitialState as _InitialState, AcceptSchema as _AcceptSchema } from './contract';
import type { Accept as _Accept, State as _State } from './contract';
import * as _selectors from './selectors';
${entities.map(entity => `import { ${entity}Entity as _entity_${entity} } from './entities/${entity}';\n`).join('')}
export const ${name}Aggregate = _createAggregate<_State, '${name}'>('${name}', _InitialState)
  .events({ accepted: (state, event: _Event<_Accept>) => {
    state.id = event.payload.id;
    state.accepted = true;
  } })
  .commands((emit) => ({ accept: (_state, payload: _Accept) => emit.accepted(_AcceptSchema.parse(payload)) }))
  .entities({${entities.map(entity => ` ${entity}: _entity_${entity},`).join('')} })
  .selectors(_selectors);

export const ${name} = ${name}Aggregate.build();
`;

export const selectorsTemplate = () => `import type { State } from './contract';

export const getCoreState = (state: State): State => state;
export const isAccepted = (state: State): boolean => state.accepted;
`;

export const entityTemplate = (name: string) => `import { createEntity as _createEntity } from '@redemeine/aggregate';
import type { Event as _Event } from '@redemeine/kernel';

export interface ${name}State { id: string; value: string }

export const ${name}Entity = _createEntity<${name}State, '${name}'>('${name}')
  .events({ changed: (state, event: _Event<${name}State>) => { state.value = event.payload.value; } })
  .commands((emit) => ({ change: (_state, payload: ${name}State) => emit.changed(payload) }))
  .build();
`;

export const aggregateSpecTemplate = (name: string) => `import { describe, expect, it } from 'vitest';
import { ${name} as _aggregate } from './aggregate';
import { reduce } from '../../test-utils';

describe('${name}', () => {
  it('accepts and applies a command without mutating initial state', () => {
    const events = _aggregate.process(_aggregate.initialState, _aggregate.commandCreators.accept({ id: '123' }));
    expect(events[0]?.type).toBe('${name}.accepted.event');
    const state = reduce(_aggregate.apply, _aggregate.initialState, events);
    expect(state).toMatchObject({ id: '123', accepted: true });
    expect(_aggregate.initialState.accepted).toBe(false);
  });
  it('rejects an invalid payload', () => {
    expect(() => _aggregate.process(_aggregate.initialState, _aggregate.commandCreators.accept({ id: '' }))).toThrow();
  });
});
`;

export const testUtilsTemplate = () => `export function reduce<State, Event>(
  apply: (state: State, event: Event) => State,
  initialState: State,
  events: readonly Event[],
): State {
  return events.reduce(apply, initialState);
}
`;
