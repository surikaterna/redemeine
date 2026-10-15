import * as ts from 'typescript';

type Member = { type: ts.Type; schema: string | null };
type Conversion = { convert(type: ts.Type, depth: number): string; object(type: ts.Type, depth: number): string };

function objectShape(type: ts.Type, checker: ts.TypeChecker): boolean {
    return !!(type.flags & ts.TypeFlags.Object)
        && !checker.isArrayType(type) && !checker.isTupleType(type)
        && !type.getCallSignatures().length && !type.getConstructSignatures().length
        && type.getSymbol()?.name !== 'Date'
        && checker.getIndexInfosOfType(type).every(index => !!(index.keyType.flags & ts.TypeFlags.String))
        && !checker.getPropertiesOfType(type).some(property => property.name.startsWith('__@'));
}

export function intersectionSchema(type: ts.Type, members: Member[], checker: ts.TypeChecker,
    depth: number, conversion: Conversion): string {
    const objects = members.every(member => objectShape(member.type, checker));
    const arrays = members.every(member => checker.isArrayType(member.type) && member.type.getSymbol()?.name === 'Array');
    if (!objects && !arrays) {
        throw new Error(`Unsupported intersection ${checker.typeToString(type)}; provide an explicit typeOverrides schema.`);
    }
    // Only structural records are flattened. Supplied schemas and index constraints must survive intact.
    if (objects && members.every(member => !member.schema && !checker.getIndexInfosOfType(member.type).length)) {
        return conversion.object(type, depth);
    }
    const parts = members.map(member => member.schema ?? conversion.convert(member.type, depth + 1));
    return parts.slice(1).reduce((left, right) => `z.intersection(${left}, ${right})`, parts[0]!);
}
