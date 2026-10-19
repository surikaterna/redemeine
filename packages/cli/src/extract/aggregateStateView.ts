import * as ts from 'typescript';
import { canonicalAggregateDeclaration } from './schemaRegistryProvenance';

function sameView(checker: ts.TypeChecker, left: ts.Type, right: ts.Type, seen = new Map<ts.Type, Set<ts.Type>>()): boolean {
    if (left === right || seen.get(left)?.has(right)) return true;
    if (seen.size >= 256 || !checker.isTypeAssignableTo(left, right) || !checker.isTypeAssignableTo(right, left)) return false;
    const pairs = seen.get(left) ?? new Set<ts.Type>();
    pairs.add(right);
    seen.set(left, pairs);
    if (!(left.flags & ts.TypeFlags.Object) || !(right.flags & ts.TypeFlags.Object)) return true;
    const properties = checker.getPropertiesOfType(left);
    if (properties.length !== checker.getPropertiesOfType(right).length) return false;
    return properties.every(property => {
        const other = checker.getPropertyOfType(right, property.name);
        return !!other && (property.flags & ts.SymbolFlags.Optional) === (other.flags & ts.SymbolFlags.Optional)
            && sameView(checker, checker.getTypeOfSymbol(property), checker.getTypeOfSymbol(other), seen);
    });
}

/** Compare readonly views to readonly views, never to a mutable Date model. */
export function assertAggregateStateView(checker: ts.TypeChecker, aggregate: ts.Type, view: ts.Type | null): void {
    const apply = checker.getPropertyOfType(aggregate, 'apply');
    const declarations = apply?.declarations ?? [];
    if (!apply || !view || !declarations.length || declarations.some(node => !canonicalAggregateDeclaration(node))) {
        throw new Error('state: erased canonical aggregate view contract');
    }
    const signature = checker.getTypeOfSymbol(apply).getCallSignatures()[0];
    if (!signature || !sameView(checker, view, checker.getReturnTypeOfSignature(signature))) {
        throw new Error('state: incompatible schema views between initialState and canonical apply contract');
    }
}
