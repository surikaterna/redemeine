import { describe, expect, test } from 'bun:test';
import { createProjection } from '../src/index';

describe('projection-runtime-core exports', () => {
  test('createProjection returns builder with build()', () => {
    const builder = createProjection('runtime-core-export-smoke', () => ({ id: '' }));
    expect(typeof builder.build).toBe('function');
  });
});
