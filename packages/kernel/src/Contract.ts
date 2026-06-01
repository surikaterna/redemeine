import type { ZodType } from 'zod';

/**
 * Thrown when an invalid payload boundary is breached (e.g. Zod validation failure).
 * Specifically halts invalid Commands or Events entering/leaving the Aggregate root.
 */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

/**
 * Thrown when an applied event attempts to mutate current state into an invalid structure.
 * Validates integrity logic post-event application.
 */
export class StateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateIntegrityError';
    Object.setPrototypeOf(this, StateIntegrityError.prototype);
  }
}

/**
 * foundational binding layer for Zod integration.
 * Responsible for verifying all Events, Commands, and State schemas dynamically against the definitions.
 */
export class Contract {
  private readonly _commands: Map<string, ZodType> = new Map();
  private readonly _events: Map<string, ZodType> = new Map();
  public stateSchema?: ZodType;

  get commands(): ReadonlyMap<string, ZodType> {
    return this._commands;
  }

  get events(): ReadonlyMap<string, ZodType> {
    return this._events;
  }

  addCommand(type: string, schema: ZodType): this {
    this._commands.set(type, schema);
    return this;
  }

  addEvent(type: string, schema: ZodType): this {
    this._events.set(type, schema);
    return this;
  }

  setStateSchema(schema: ZodType): this {
    this.stateSchema = schema;
    return this;
  }

  getCommand(type: string): ZodType | undefined {
    return this._commands.get(type);
  }

  getEvent(type: string): ZodType | undefined {
    return this._events.get(type);
  }

  validateCommand<T = unknown>(type: string, data: unknown): T {
    return this.validate<T>(this._commands, 'Command', type, data);
  }

  validateEvent<T = unknown>(type: string, data: unknown): T {
    return this.validate<T>(this._events, 'Event', type, data);
  }

  private validate<T>(schemas: Map<string, ZodType>, kind: string, type: string, data: unknown): T {
    const schema = schemas.get(type);
    if (!schema) {
      throw new ContractError(`${kind} schema not found for type: ${type}`);
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ContractError(
        `${kind} validation failed for type ${type}: ${result.error.message}`
      );
    }
    return result.data as T;
  }

  validateState<T = unknown>(data: unknown): T {
    if (!this.stateSchema) return data as T;
    const result = this.stateSchema.safeParse(data);
    if (!result.success) {
      throw new StateIntegrityError(
        `State integration failed: ${result.error.message}`
      );
    }
    return result.data as T;
  }

  private static isZodLike(value: unknown): value is ZodType {
    return value != null && typeof (value as ZodType).safeParse === 'function';
  }

  static fromZodExports(exportsObj: Record<string, unknown>): Contract {
    const contract = new Contract();
    
    const normalizeName = (key: string) => {
      const typeName = key.endsWith('Schema') ? key.slice(0, -6) : key;
      return typeName.charAt(0).toLowerCase() + typeName.slice(1);
    };

    if (exportsObj.Commands) {
      for (const [key, schema] of Object.entries(exportsObj.Commands as Record<string, unknown>)) {
        if (Contract.isZodLike(schema)) {
          contract.addCommand(normalizeName(key), schema);
        }
      }
    }

    if (exportsObj.Events) {
      for (const [key, schema] of Object.entries(exportsObj.Events as Record<string, unknown>)) {
        if (Contract.isZodLike(schema)) {
          contract.addEvent(normalizeName(key), schema);
        }
      }
    }

    if (Contract.isZodLike(exportsObj.State)) {
      contract.setStateSchema(exportsObj.State);
    }

    return contract;
  }
}
