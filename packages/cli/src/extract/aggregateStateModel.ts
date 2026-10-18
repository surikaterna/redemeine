import * as ts from 'typescript';
import { canonicalAggregateDeclaration } from './schemaRegistryProvenance';
import { assertAggregateStateView } from './aggregateStateView';

function includesNullish(type: ts.Type): boolean {
    return (type.isUnion() ? type.types : [type]).some(part => !!(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
}

function interfaceModel(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
    if (type.isIntersection()) {
        for (const part of type.types) {
            const model = interfaceModel(checker, part);
            if (model) return model;
        }
    }
    if (!(type.flags & ts.TypeFlags.Object)) return undefined;
    const reference = type as ts.TypeReference;
    const declaration = reference.target?.getSymbol()?.declarations?.find(ts.isInterfaceDeclaration);
    if (declaration?.name.text !== 'BuiltAggregate' || !canonicalAggregateDeclaration(declaration)) return undefined;
    return checker.getTypeArguments(reference)[0];
}

/** The marker owns the model; the view only proves whether optionality injected undefined. */
export function aggregateStateModel(checker: ts.TypeChecker, aggregate: ts.Type, view: ts.Type | null): ts.Type | null {
    const marker = checker.getPropertyOfType(aggregate, '__stateType');
    if (!marker) return view;
    const declarations = marker.declarations ?? [];
    if (!declarations.length || declarations.some(node => !canonicalAggregateDeclaration(node))) {
        throw new Error('state: noncanonical aggregate model marker; use a genuine aggregate declaration');
    }
    assertAggregateStateView(checker, aggregate, view);
    const model = interfaceModel(checker, aggregate);
    const value = checker.getTypeOfSymbol(marker);
    if (!model && (!view || includesNullish(view))) throw new Error('state: unresolved aggregate model marker; supply an explicit whole-model schema');
    // Canonical builder state is S & PS. Its required view preserves root nullish branches.
    const resolved = model ?? checker.getNonNullableType(value);
    if (resolved.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
        throw new Error('state: unresolved aggregate model marker; supply an explicit whole-model schema');
    }
    return resolved;
}
