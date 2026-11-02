import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

type Leaf = { id: string; qty: number };
type Child = { id: string; label: string; leaves: Leaf[] };
type State = { title: string; children: Child[]; byKey: Record<string, Child> };

const leaf = createEntity<Leaf, 'leaf'>('leaf')
  .events({ qtyChanged(state, event: Event<{ qty: number }>) { state.qty = event.payload.qty; } })
  .commands(emit => ({ changeQty(_state, payload: { id: string; qty: number }) { return emit.qtyChanged(payload); } }))
  .build();

const child = createEntity<Child, 'child'>('child')
  .entityList('leaves', leaf)
  .events({ labelChanged(state, event: Event<{ label: string }>) { state.label = event.payload.label; } })
  .commands(emit => ({ changeLabel: {
    pack: (id: string, label: string) => ({ id, label }),
    handler(_state: unknown, payload: { id: string; label: string }) { return emit.labelChanged(payload); },
  } }))
  .build();

export const aggregateBuilder = createAggregate('root', { title: '', children: [], byKey: {} } as State)
  .entityList('children', child)
  .entityMap('byKey', child)
  .events({ titleChanged(state, event: Event<{ title: string }>) { state.title = event.payload.title; } })
  .commands(emit => ({ changeTitle(_state, payload: { title: string }) { return emit.titleChanged(payload); } }));

export const aggregate: ReturnType<typeof aggregateBuilder.build> = aggregateBuilder.build();

throw Error('Aggregate source must not execute during extraction');
