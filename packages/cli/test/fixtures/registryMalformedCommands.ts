import { aggregate } from './registryCommands';

declare const authoredCreators: {
    [K in 'bad' as `mapped${Capitalize<K>}`]: (input: string) => { type: string; payload: { id: string } };
};
export const unrelated = { ...aggregate, commandCreators: authoredCreators };
export const malformed = { ...aggregate, commandCreators: { bad: () => ({ payload: 1 }) } };
export const noncallableSelector = { ...aggregate, selectors: { getCoreState: 1 } };
declare const authoredSelectors: { [K in 'getCoreState']: (state: { count: number }) => { count: number } };
export const unrelatedSelectors = { ...aggregate, selectors: authoredSelectors };
