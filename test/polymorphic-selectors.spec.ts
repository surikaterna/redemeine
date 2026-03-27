import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createEntity } from '../src/createEntity';
import { createMirage } from '../src/createMirage';
import { Event } from '../src/types';
import type { ReadonlyDeep } from '../src/utils/types/ReadonlyDeep';

type ActivityKind = 'LEG' | 'STOP';

type LineState = {
  id: string;
  type: { identifier: ActivityKind };
  status: 'IDLE' | 'DEPARTED' | 'ARRIVED';
};

type RootState = {
  lines: LineState[];
};

describe('polymorphic selector bindContext', () => {
  test('routes role commands through root aggregate dispatcher', async () => {
    const lineEntity = createEntity<LineState, 'line'>('line')
      .events({
        departed: (line, event: Event<{ id: string }>) => {
          if (line.id === event.payload.id) {
            line.status = 'DEPARTED';
          }
        },
        arrived: (line, event: Event<{ id: string }>) => {
          if (line.id === event.payload.id) {
            line.status = 'ARRIVED';
          }
        }
      })
      .commands((emit) => ({
        depart: (line, payload: { id: string }) => emit.departed({ id: payload.id }),
        arrive: (line, payload: { id: string }) => emit.arrived({ id: payload.id })
      }))
      .build();

    const legRole = createEntity<LineState, 'legRole'>('legRole')
      .events({})
      .commands(() => ({
        depart: () => []
      }))
      .build();

    const stopRole = createEntity<LineState, 'stopRole'>('stopRole')
      .events({})
      .commands(() => ({
        arrive: () => []
      }))
      .build();

    const aggregate = createAggregate<RootState, 'shipment'>('shipment', {
      lines: [
        { id: 'L1', type: { identifier: 'LEG' }, status: 'IDLE' },
        { id: 'S1', type: { identifier: 'STOP' }, status: 'IDLE' }
      ]
    })
      .entityList('lines', lineEntity)
      .selectors(({ bindContext }) => ({
        getActivities: (state: ReadonlyDeep<RootState>) =>
          bindContext(state.lines, 'type.identifier', {
            LEG: legRole,
            STOP: stopRole
          } as const)
      }))
      .build();

    const mirage = createMirage(aggregate, 'shipment-1');

    await (mirage.getActivities()[0] as any).depart();

    expect(mirage.lines[0].status).toBe('DEPARTED');
    if (false) {
      const activities = mirage.getActivities();
      type Activity = (typeof activities)[number];
      type StopActivity = Extract<Activity, { type: { identifier: 'STOP' } }>;

      // @ts-expect-error STOP role should not expose depart()
      (null as unknown as StopActivity).depart();
    }
  });
});
