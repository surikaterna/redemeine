import * as ts from 'typescript';
import { TypeToZodConverter } from './typeConverter';
import { ProjectionTypeConverter } from './projectionTypeConverter';
import type { SchemaPolicy } from './schemaConfig';
import { schemaComposition } from './schemaComposition';

/** Registry/projection structural restrictions remain; authored schemas take precedence. */
export function schemaAwareConversion(program: ts.Program, policy: SchemaPolicy, outFile: string, prefix = '', sortProperties = false, aggregateModel = false) {
    const references = new TypeToZodConverter(program.getTypeChecker(), program, 'string', {}, outFile, policy, prefix);
    const resolveSchema = (type: ts.Type, declaration?: ts.Node): string | null => {
        const schema = references.resolveExistingSchema(type, declaration);
        if (!schema && schemaComposition(program.getTypeChecker(), type, declaration, policy.maxProvenanceDepth)) {
            throw new Error('Projection/registry schema composition requires an explicit derived Zod schema');
        }
        return schema;
    };
    const structural = new ProjectionTypeConverter(program.getTypeChecker(), sortProperties, policy.maxDepth,
        resolveSchema, aggregateModel, policy.maxProvenanceDepth);
    return {
        imports: references.imports,
        convert(type: ts.Type, path: string, declaration?: ts.Node): string {
            const schema = resolveSchema(type, declaration);
            if (schema) return schema;
            if (policy.mode === 'zod-first') return references.fail(type, path, 'no importable Zod schema; supply a schema-derived type or opt in to types-first');
            return structural.convert(type, path, declaration);
        }
    };
}
