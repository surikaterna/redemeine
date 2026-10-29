import type { GenericCommandFactory, GenericCommandMap } from './redemeineComponent';

export type EntityExecutionContext = { readonly isNew: boolean };
const modes = new WeakMap<object, Record<string, boolean>>();

export function commandModes(definitions: object): Record<string, boolean> {
  let result = modes.get(definitions);
  if (!result) { result = Object.create(null) as Record<string, boolean>; modes.set(definitions, result); }
  return result;
}

export function entityCommands(factory: GenericCommandFactory, names: readonly string[], hasTemplate: boolean): GenericCommandFactory {
  const selected = [...names];
  if (selected.length && !hasTemplate) throw new Error('Static entity commands require an initial state');
  return (emit, context): GenericCommandMap => {
    const definitions = factory(emit, context);
    for (const name of selected) {
      if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown static entity command: ${name}`);
    }
    const result = Object.assign(Object.create(null), definitions) as GenericCommandMap;
    for (const name of Object.keys(result)) commandModes(result)[name] = selected.includes(name);
    return result;
  };
}
