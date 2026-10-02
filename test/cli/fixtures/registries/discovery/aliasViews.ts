import { account, publicView } from './mixed';
import type { ProjectionDefinition } from '../../../../../packages/projection/src';

interface Broader extends Omit<typeof account, 'initialState'> { initialState: { total: number; extra?: string } }
export const broad: Broader = account;
interface Equivalent extends Omit<typeof account, 'initialState'> { initialState: { total: number } }
export const equivalent: Equivalent = account;
interface EquivalentAgain extends Omit<typeof account, 'initialState'> { initialState: { total: number } }
export const equivalentAgain: EquivalentAgain = account;
interface BroaderCommand extends Omit<typeof account, 'commandCreators'> {
  commandCreators: { add(amount: number): { type: string; payload: number | string } };
}
export const broadCommand: BroaderCommand = account;
export const broadProjection: ProjectionDefinition<{ id: string; active: boolean; extra?: string }> = publicView;
export const equivalentProjection: ProjectionDefinition<{ active: boolean; id: string }> = publicView;
