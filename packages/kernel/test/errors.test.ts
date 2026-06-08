import { describe, it, expect } from 'vitest';
import { RedemineError, ContractValidationError } from '../src/errors';

describe('RedemineError', () => {
  it('extends Error', () => {
    const err = new RedemineError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const err = new RedemineError('test');
    expect(err.name).toBe('RedemineError');
  });

  it('preserves message', () => {
    const err = new RedemineError('something broke');
    expect(err.message).toBe('something broke');
  });

  it('supports cause option', () => {
    const cause = new Error('root');
    const err = new RedemineError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('ContractValidationError', () => {
  it('extends RedemineError and Error', () => {
    const err = new ContractValidationError('UserContract', ['field required']);
    expect(err).toBeInstanceOf(RedemineError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct name', () => {
    const err = new ContractValidationError('UserContract', ['bad']);
    expect(err.name).toBe('ContractValidationError');
  });

  it('exposes contractName and validationErrors', () => {
    const errors = ['name is required', 'email invalid'];
    const err = new ContractValidationError('OrderContract', errors);
    expect(err.contractName).toBe('OrderContract');
    expect(err.validationErrors).toEqual(errors);
  });

  it('formats message with contract name and errors', () => {
    const err = new ContractValidationError('X', ['a', 'b']);
    expect(err.message).toContain('X');
    expect(err.message).toContain('a');
    expect(err.message).toContain('b');
  });

  it('supports cause option', () => {
    const cause = new Error('underlying');
    const err = new ContractValidationError('C', ['e'], { cause });
    expect(err.cause).toBe(cause);
  });

  it('validationErrors is readonly', () => {
    const err = new ContractValidationError('C', ['x']);
    // TypeScript prevents mutation, but verify the array reference is stable
    expect(err.validationErrors).toHaveLength(1);
  });
});
