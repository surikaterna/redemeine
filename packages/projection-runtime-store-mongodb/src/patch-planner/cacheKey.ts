import type { ProjectionStoreRfc6902Operation } from '../contracts';

const typeTag = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
};

export const makeCacheKey = (patch: ReadonlyArray<ProjectionStoreRfc6902Operation>): string => {
  const shape = patch.map((op) => {
    const valueType = op.op === 'test' || op.op === 'add' || op.op === 'replace' ? typeTag((op as { value?: unknown }).value) : '-';
    return `${op.op}|${op.path}|${'from' in op && op.from ? op.from : '-'}|${valueType}`;
  });

  return shape.join('::');
};
