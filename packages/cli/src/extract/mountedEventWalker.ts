import * as ts from 'typescript';

export interface ResolvedEvent {
    payload: ts.Type;
    parameter?: ts.Declaration;
    payloadDeclaration?: ts.Declaration;
}

function property(checker: ts.TypeChecker, type: ts.Type, key: string, node: ts.Node): ts.Type | undefined {
    const symbol = checker.getPropertyOfType(type, key);
    return symbol ? checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? symbol.declarations?.[0] ?? node) : undefined;
}

function concrete(checker: ts.TypeChecker, type: ts.Type | undefined, path: string): ts.Type {
    if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never)
        || type.isUnion() || checker.getIndexInfosOfType(type).length) {
        throw new Error(`${path}: unresolved or ambiguous declared event registry`);
    }
    return type;
}

function resolveEvent(checker: ts.TypeChecker, handler: ts.Type, node: ts.Node, path: string): ResolvedEvent {
    const signatures = handler.getCallSignatures();
    const signature = signatures.length === 1 ? signatures[0] : undefined;
    if (!signature) throw new Error(`${path}: ambiguous or unresolved event handler`);
    const event = signature.getParameters()[1];
    if (!event) return { payload: checker.getVoidType() };
    const parameter = event.valueDeclaration ?? event.declarations?.[0];
    const eventType = checker.getTypeOfSymbolAtLocation(event, parameter ?? node);
    const payload = property(checker, eventType, 'payload', node);
    if (!payload || payload.flags & ts.TypeFlags.TypeParameter) {
        throw new Error(`${path}: missing concrete Event payload`);
    }
    const symbol = checker.getPropertyOfType(eventType, 'payload');
    const payloadDeclaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return { payload, ...(parameter ? { parameter } : {}), ...(payloadDeclaration ? { payloadDeclaration } : {}) };
}

/** Schema IDs describe declaration mounts, never semantic names or runtime wire winners. */
export function resolvedAggregateEvents(checker: ts.TypeChecker, aggregate: ts.Type, node: ts.Node): Map<string, ResolvedEvent> {
    const result = new Map<string, ResolvedEvent>();
    const add = (handlers: ts.Type | undefined, segments: readonly string[]): void => {
        const container = concrete(checker, handlers, segments.join('.') || 'events');
        for (const symbol of container.getProperties()) {
            const key = [...segments, symbol.name].join('.');
            if (result.has(key)) throw new Error(`${key}: declared event schema ID collision`);
            const handler = property(checker, container, symbol.name, node)!;
            result.set(key, resolveEvent(checker, handler, node, key));
        }
    };
    const pure = property(checker, aggregate, 'pure', node);
    add(pure && property(checker, pure, 'eventProjectors', node), []);
    walkRegistry(checker, aggregate, node, [], new Set(), add);
    return result;
}

function walkRegistry(checker: ts.TypeChecker, owner: ts.Type, node: ts.Node, segments: readonly string[],
    ancestors: Set<ts.Type>, add: (handlers: ts.Type | undefined, segments: readonly string[]) => void): void {
    const marker = property(checker, owner, '__registryType', node);
    if (!marker) return; // Legacy root aggregates legitimately have no registry marker.
    if (marker.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
        throw new Error(`${segments.join('.')}: unresolved declared event registry`);
    }
    const registry = concrete(checker, checker.getNonNullableType(marker), [...segments, '__registryType'].join('.'));
    if (ancestors.has(registry)) throw new Error(`${segments.join('.')}: cyclic declared event registry`);
    const next = new Set(ancestors).add(registry);
    for (const symbol of registry.getProperties()) {
        const path = [...segments, symbol.name];
        const entry = concrete(checker, property(checker, registry, symbol.name, node), path.join('.'));
        const kind = property(checker, entry, 'kind', node);
        if (!kind?.isStringLiteral()) throw new Error(`${path.join('.')}: unresolved mount kind`);
        if (['valueObject', 'valueObjectList', 'valueObjectMap'].includes(kind.value)) continue;
        if (kind.value !== 'list' && kind.value !== 'map') throw new Error(`${path.join('.')}: unsupported mount kind`);
        const entity = concrete(checker, property(checker, entry, 'entity', node), path.join('.'));
        add(property(checker, entity, 'events', node), path);
        walkRegistry(checker, entity, node, path, next, add);
    }
}
