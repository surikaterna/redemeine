import type { SagaCommandMap, SagaDefinition } from './createSaga';

/** Named saga registration entry used by runtime discovery. */
export interface RegisteredSagaDefinition<
  TState = unknown,
  TCommandMap extends SagaCommandMap = SagaCommandMap
> {
  name: string;
  definition: SagaDefinition<TState, TCommandMap>;
}

/** Registry contract for saga discovery and lookup. */
export interface SagaRegistry {
  register<TState, TCommandMap extends SagaCommandMap>(
    saga: RegisteredSagaDefinition<TState, TCommandMap>
  ): void;
  list(): RegisteredSagaDefinition[];
  get(name: string): RegisteredSagaDefinition | undefined;
}

class InMemorySagaRegistry implements SagaRegistry {
  private readonly sagas = new Map<string, RegisteredSagaDefinition>();

  register<TState, TCommandMap extends SagaCommandMap>(
    saga: RegisteredSagaDefinition<TState, TCommandMap>
  ): void {
    this.sagas.set(saga.name, saga as RegisteredSagaDefinition);
  }

  list(): RegisteredSagaDefinition[] {
    return Array.from(this.sagas.values());
  }

  get(name: string): RegisteredSagaDefinition | undefined {
    return this.sagas.get(name);
  }
}

export function createSagaRegistry(): SagaRegistry {
  return new InMemorySagaRegistry();
}

const runtimeSagaRegistry = createSagaRegistry();

/** Returns the shared in-process saga registry instance. */
export function getSagaRegistry(): SagaRegistry {
  return runtimeSagaRegistry;
}

/** Registers a named saga in the provided or shared runtime registry. */
export function registerSaga<TState, TCommandMap extends SagaCommandMap>(
  saga: RegisteredSagaDefinition<TState, TCommandMap>,
  registry: SagaRegistry = runtimeSagaRegistry
): RegisteredSagaDefinition<TState, TCommandMap> {
  registry.register(saga);
  return saga;
}
