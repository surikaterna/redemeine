import * as ts from 'typescript';

export const defaultMaxProvenanceDepth = 256;

export function assertProvenanceDepth(depth: number, limit: number, path = 'schema'): void {
    if (depth > limit) throw new Error(`${path}: schema provenance depth exceeds maxProvenanceDepth (${limit}); supply a direct schema-derived type or increase redemeine.schemas.maxProvenanceDepth`);
}

export function syntaxChildren(node: ts.Node): ts.Node[] {
    const children: ts.Node[] = [];
    ts.forEachChild(node, child => { children.push(child); });
    return children;
}

type Step<T> = { value?: T; children?: readonly ts.Node[] };

/** Depth bounds unresolved paths, not the width of a declaration graph. Memoized
 * nodes terminate cycles and shared branches without recursive JS stack growth. */
export function searchProvenance<T>(roots: readonly ts.Node[], inspect: (node: ts.Node) => Step<T>,
    limit = defaultMaxProvenanceDepth, path = 'schema'): T | undefined {
    const seen = new Set<ts.Node>();
    const pending = roots.slice().reverse().map(node => ({ node, depth: 1 }));
    while (pending.length) {
        const { node, depth } = pending.pop()!;
        if (seen.has(node)) continue;
        assertProvenanceDepth(depth, limit, path);
        seen.add(node);
        const step = inspect(node);
        if (step.value !== undefined) return step.value;
        const children = step.children ?? [];
        for (let index = children.length - 1; index >= 0; index--) pending.push({ node: children[index]!, depth: depth + 1 });
    }
    return undefined;
}
