import type { ZodTypeAny } from 'zod';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

export class StateIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateIntegrityError';
    Object.setPrototypeOf(this, StateIntegrityError.prototype);
  }
}

export class Contract {
  public commands: Map<string, ZodTypeAny>;
  public events: Map<string, ZodTypeAny>;
  public stateSchema?: ZodTypeAny;

  constructor() {
    this.commands = new Map();
    this.events = new Map();
  }

  addCommand(type: string, schema: ZodTypeAny): this {
    this.commands.set(type, schema);
    return this;
  }

  addEvent(type: string, schema: ZodTypeAny): this {
    this.events.set(type, schema);
    return this;
  }

  setStateSchema(schema: ZodTypeAny): this {
    this.stateSchema = schema;
    return this;
  }

  getCommand(type: string): ZodTypeAny | undefined {
    return this.commands.get(type);
  }

  getEvent(type: string): ZodTypeAny | undefined {
    return this.events.get(type);
  }

  validateCommand(type: string, data: unknown): any {
    const schema = this.commands.get(type);
    if (!schema) {
      throw new ContractError(`Command schema not found for type: ${type}`);
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ContractError(
        `Command validation failed for type ${type}: ${result.error.message}`
      );
    }
    return result.data;
  }

  validateEvent(type: string, data: unknown): any {
    const schema = this.events.get(type);
    if (!schema) {
      throw new ContractError(`Event schema not found for type: ${type}`);
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ContractError(
        `Event validation failed for type ${type}: ${result.error.message}`
      );
    }
    return result.data;
  }

  validateState(data: unknown): any {
    if (!this.stateSchema) return data;
    const result = this.stateSchema.safeParse(data);
    if (!result.success) {
      throw new StateIntegrityError(
        `State integration failed: ${result.error.message}`
      );
    }
    return result.data;
  }

  static fromZodExports(exportsObj: any): Contract {
    const contract = new Contract();
    
    const normalizeName = (key: string) => {
      const typeName = key.endsWith('Schema') ? key.slice(0, -6) : key;
      return typeName.charAt(0).toLowerCase() + typeName.slice(1);
    };

    if (exportsObj.Commands) {
      for (const [key, schema] of Object.entries(exportsObj.Commands)) {
        if (schema && typeof (schema as any).safeParse === 'function') {
          contract.addCommand(normalizeName(key), schema as ZodTypeAny);
        }
      }
    }

    if (exportsObj.Events) {
      for (const [key, schema] of Object.entries(exportsObj.Events)) {
        if (schema && typeof (schema as any).safeParse === 'function') {
          contract.addEvent(normalizeName(key), schema as ZodTypeAny);
        }
      }
    }

    if (exportsObj.State && typeof (exportsObj.State as any).safeParse === 'function') {
      contract.setStateSchema(exportsObj.State as ZodTypeAny);
    }

    return contract;
  }
}
