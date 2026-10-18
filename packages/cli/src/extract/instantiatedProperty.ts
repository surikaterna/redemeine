import * as ts from 'typescript';

/** Finite Record mounts have instantiated symbols but no property declaration. */
export function instantiatedProperty(checker: ts.TypeChecker, parent: ts.Type, property: ts.Symbol): ts.Type | undefined {
    if (parent.isIntersection()) {
        for (const part of parent.types) {
            const value = instantiatedProperty(checker, part, property);
            if (value) return value;
        }
        return undefined;
    }
    const record = parent.aliasSymbol;
    const [key, value] = parent.aliasTypeArguments ?? [];
    if (record?.name !== 'Record' || !record.declarations?.every(node => /\/lib\.[^/]+\.d\.ts$/.test(node.getSourceFile().fileName))) return undefined;
    if (!key?.isStringLiteral() || key.value !== property.name || !value || checker.getPropertyOfType(parent, property.name) !== property) return undefined;
    if (!(value.flags & ts.TypeFlags.Object) || checker.getTypeOfSymbol(property) !== value) return undefined;
    return value;
}
