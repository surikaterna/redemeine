import { Event } from './src/createEvent';
type ExtractEventPayload<E> = E extends { payload: infer P } ? P : never;
type ExtractProjectorEvent<E> = E extends { project(state: any, event: infer Ev): any } ? Ev : E extends { project: (state: any, event: infer Ev) => any } ? Ev : never;
type TestE = { project: (state: any, event: Event<{with: number}>) => void };
export type EvType = ExtractProjectorEvent<TestE>;
export type PType = ExtractEventPayload<EvType>;
type IsVoid<P> = [P] extends [void | undefined] ? true : false;
export type TestIsVoid = IsVoid<PType>;
