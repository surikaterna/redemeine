import * as ts from 'typescript';
import type { SchemaRegistryDiscovery, SchemaRegistrySelection } from '../schemaRegistryManifest';
import { classifyDefinition, type DefinitionCandidate } from './schemaRegistryDefinitionClassifier';
import { canonicalSymbol, moduleValues, selectedSymbol, valueType } from './schemaRegistryIdentity';
import { registryName } from './schemaRegistryNavigator';
import { requiredString } from '../schemaRegistryManifest';
import { reconcileSchemaViews } from './schemaRegistryView';

type Route = { selection: SchemaRegistrySelection; symbol: ts.Symbol; value: ts.Symbol; candidate?: DefinitionCandidate; explicit: boolean };

function discoveredRoutes(program: ts.Program, discoveries: readonly SchemaRegistryDiscovery[]): Route[] {
  const checker = program.getTypeChecker();
  const cache = new Map<string, string | undefined>();
  return discoveries.flatMap((discovery) => {
    const eligible = new Map<string, { symbol: ts.Symbol; candidate: DefinitionCandidate }>();
    for (const [name, symbol] of moduleValues(program, discovery.entry)) {
      const candidate = classifyDefinition(checker, symbol, cache);
      if (candidate?.evidence.kind === discovery.kind) eligible.set(name, { symbol, candidate });
    }
    const excluded = new Set(discovery.exclude ?? []);
    for (const name of excluded) if (!eligible.has(name)) throw new Error(`${discovery.entry}: exclude ${name} is not an eligible ${discovery.kind} export`);
    for (const name of Object.keys(discovery.names ?? {})) {
      if (!eligible.has(name) || excluded.has(name)) throw new Error(`${discovery.entry}: names ${name} must be an eligible nonexcluded export`);
    }
    return [...eligible].filter(([name]) => !excluded.has(name)).map(([name, value]) => ({
      selection: { kind: discovery.kind, entry: discovery.entry, export: name,
        ...(discovery.names && Object.hasOwn(discovery.names, name) ? { name: requiredString(discovery.names[name], name) } : {}) },
      symbol: canonicalSymbol(checker, value.symbol), value: value.symbol, candidate: value.candidate, explicit: false,
    }));
  });
}

function mergeGroup(program: ts.Program, routes: Route[]): SchemaRegistrySelection {
  const checker = program.getTypeChecker();
  const first = routes[0];
  if (!first) throw new Error('empty canonical definition group');
  if (routes.filter((route) => route.explicit).length > 1) throw new Error(`${first.selection.export}: duplicate explicit ${first.selection.kind} selection`);
  const supplied = new Set(routes.flatMap((route) => route.selection.name === undefined ? [] : [route.selection.name]));
  if (supplied.size > 1) throw new Error(`${first.selection.export}: conflicting names for canonical aliases`);
  const name = [...supplied][0];
  let effective: string | undefined;
  for (const route of routes) {
    validateRoute(route);
    const selection = { ...route.selection, ...(name === undefined ? {} : { name }) };
    const resolved = registryName(checker, valueType(checker, route.value), selection);
    if (effective !== undefined && resolved !== effective) throw new Error(`${route.selection.export}: conflicting canonical identity names`);
    effective = resolved;
  }
  const selections = routes.map((route) => ({ ...route.selection, ...(effective === undefined ? {} : { name: effective }) }));
  reconcileSchemaViews(program, selections);
  return { ...first.selection, ...(effective === undefined ? {} : { name: effective }) };
}

function validateRoute(route: Route): void {
  try {
    route.candidate?.validate();
  } catch (error) {
    throw new Error(`${route.selection.entry}:${route.selection.export}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function discoverRegistrySelections(program: ts.Program, definitions: readonly SchemaRegistrySelection[],
  discoveries: readonly SchemaRegistryDiscovery[]): SchemaRegistrySelection[] {
  if (!discoveries.length) return [...definitions];
  const checker = program.getTypeChecker();
  const routes: Route[] = definitions.map((selection) => {
    const value = moduleValues(program, selection.entry).get(selection.export);
    if (!value) throw new Error(`${selection.entry}: missing value export ${selection.export}`);
    return { selection, value, symbol: selectedSymbol(program, selection.entry, selection.export), explicit: true };
  });
  routes.push(...discoveredRoutes(program, discoveries));
  const groups = new Map<ts.Symbol, Map<string, Route[]>>();
  for (const route of routes) {
    const kinds = groups.get(route.symbol) ?? new Map<string, Route[]>();
    const group = kinds.get(route.selection.kind) ?? [];
    group.push(route);
    kinds.set(route.selection.kind, group);
    groups.set(route.symbol, kinds);
  }
  return [...groups.values()].flatMap((kinds) => [...kinds.values()].map((group) => mergeGroup(program, group)));
}
