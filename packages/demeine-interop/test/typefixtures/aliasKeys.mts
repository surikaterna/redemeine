import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createDemeineBridge, type CompatibleAggregate } from '@redemeine/demeine-interop';

type Handler = (state: unknown, payload: { id: string }) => [];

const broadCommands: Record<string, Handler> = { change: () => [] };
const prefixCommands: Record<`change${string}`, Handler> = { change: () => [] };
const suffixCommands: Record<`${string}Change`, Handler> = { Change: () => [] };
const middleCommands: Record<`change${string}Now`, Handler> = { changeNow: () => [] };
const numberCommands: Record<`change${number}`, Handler> = { change1: () => [] };
const bigintCommands: Record<`change${bigint}`, Handler> = { change1: () => [] };
const numericCommands: Record<`${number}`, Handler> = { '1': () => [] };
const integerCommands: Record<`${bigint}`, Handler> = { '1': () => [] };
const unionCommands: Record<'rename' | `change${string}`, Handler> = { rename: () => [], change: () => [] };
const uppercaseCommands: Record<Uppercase<string>, Handler> = { CHANGE: () => [] };
const broadItem = createEntity('identifier', { id: '' }).commands(() => broadCommands).build();
const broad = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', broadItem).build()))();
const prefixItem = createEntity('identifier', { id: '' }).commands(() => prefixCommands).build();
const prefix = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', prefixItem).build()))();
const suffixItem = createEntity('identifier', { id: '' }).commands(() => suffixCommands).build();
const suffix = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', suffixItem).build()))();
const middleItem = createEntity('identifier', { id: '' }).commands(() => middleCommands).build();
const middle = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', middleItem).build()))();
const numberItem = createEntity('identifier', { id: '' }).commands(() => numberCommands).build();
const number = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', numberItem).build()))();
const bigintItem = createEntity('identifier', { id: '' }).commands(() => bigintCommands).build();
const bigint = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', bigintItem).build()))();
const numericItem = createEntity('identifier', { id: '' }).commands(() => numericCommands).build();
const numeric = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', numericItem).build()))();
const integerItem = createEntity('identifier', { id: '' }).commands(() => integerCommands).build();
const integer = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', integerItem).build()))();
const unionItem = createEntity('identifier', { id: '' }).commands(() => unionCommands).build();
const union = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', unionItem).build()))();
const uppercaseItem = createEntity('identifier', { id: '' }).commands(() => uppercaseCommands).build();
const uppercase = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', uppercaseItem).build()))();
// Flat typing is intentionally unchanged even for open command maps.
prefix.rowsChange({ id: 'a' });
union.renameIdentifier({ id: 'a' });

const literalCommands: Record<'change' | 'rename', Handler> = { change: () => [], rename: () => [] };
const literalItem = createEntity('identifier', { id: '' }).commands(() => literalCommands).build();
const literal = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', literalItem).build()))();
const result: Promise<true | CompatibleAggregate<{ readonly rows: readonly { readonly id: string }[] }>> = literal.changeIdentifier({ id: 'a' });
literal.renameIdentifier({ id: 'a' });
void result;
const unicodeItem = createEntity('identifier', { id: '' }).commands(() => ({ ändra: (_state: unknown, _payload: { id: string }): [] => [] })).build();
const unicode = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', unicodeItem).build()))();
unicode.ändraIdentifier({ id: 'a' });
const finiteCommands: Record<`change${1 | 2}` | `${boolean}`, Handler> = {
  change1: () => [], change2: () => [], true: () => [], false: () => []
};
const finiteItem = createEntity('identifier', { id: '' }).commands(() => finiteCommands).build();
const finite = new (createDemeineBridge(createAggregate('registry', { rows: [{ id: 'a' }] }).entityList('rows', finiteItem).build()))();
finite.change1Identifier({ id: 'a' });
finite.change2Identifier({ id: 'a' });
finite.trueIdentifier({ id: 'a' });
finite.falseIdentifier({ id: 'a' });

if (false) {
  // @ts-expect-error open command key has no guaranteed alias
  broad.registerIdentifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  prefix.changeMissingIdentifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  suffix.missingChangeIdentifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  middle.changeMissingNowIdentifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  number.change99Identifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  bigint.change99Identifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  const { '99Identifier': numericAlias } = numeric;
  numericAlias({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  const { '99Identifier': integerAlias } = integer;
  integerAlias({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  union.changeMissingIdentifier({ id: 'a' });
  // @ts-expect-error open command key has no guaranteed alias
  uppercase.MISSINGIdentifier({ id: 'a' });
  // @ts-expect-error literal aliases retain exact identity arguments
  literal.changeIdentifier({ id: 1 });
  // @ts-expect-error Unicode literal aliases retain exact identity arguments
  unicode.ändraIdentifier({});
}
