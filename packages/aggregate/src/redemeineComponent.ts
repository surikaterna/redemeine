import type { SelectorsMap } from '@redemeine/kernel';
import type {
  RedemeineEventDefinition,
  AnyFunction,
  ComponentBehaviorSnapshot,
  InheritableComponentBehavior
} from './componentTypes';
import { composeCommandFactories, type GenericCommandFactory } from './commandFactory';

// Re-export everything from sub-modules for backward compatibility
export type {
  GenericSelectors,
  GenericCommandMap,
  GenericCommandFactoryContext,
  GenericCommandFactory,
  RedemeineShorthandCommand,
  RedemeineCommandDefinition,
  RedemeineCommandMap
} from './commandFactory';
export {
  resolveCommandFactoryContext,
  composeCommandFactories,
  resolveCommandHandler,
  createCommandPayload
} from './commandFactory';

export type {
  RedemeineEventProjector,
  RedemeineEventDefinition,
  NormalizeEventDefinitions,
  RedemeineComponent,
  ComponentCommandUnion,
  MergeComponentCommands,
  MergeComponentCommandKeys,
  PublicCommandArgsFromDefinition,
  PublicCommandMethodsFromInternal,
  AnyFunction,
  ComponentBehaviorSnapshot,
  InheritableComponentBehavior
} from './componentTypes';

export function createComponentBehaviorState<S>() {
  let events: Record<string, AnyFunction> = {};
  let eventMetadata: Record<string, Record<string, unknown> | undefined> = {};
  let eventOverrides: Record<string, string> = {};
  let selectors: SelectorsMap<S> = {};
  let commandOverrides: Record<string, string> = {};
  let commandFactories: GenericCommandFactory[] = [];

  return {
    addEvents(next: Record<string, RedemeineEventDefinition<S, Record<string, unknown>>>) {
      const normalizedEvents: Record<string, AnyFunction> = {};
      const normalizedMeta: Record<string, Record<string, unknown> | undefined> = {};

      Object.keys(next).forEach((key) => {
        const definition = next[key];
        if (typeof definition === 'function') {
          normalizedEvents[key] = definition;
          return;
        }

        if (definition && typeof definition.projector === 'function') {
          normalizedEvents[key] = definition.projector;
          normalizedMeta[key] = definition.meta;
        }
      });

      events = { ...events, ...normalizedEvents };
      eventMetadata = { ...eventMetadata, ...normalizedMeta };
    },

    addEventOverrides(next: Record<string, string>) {
      eventOverrides = { ...eventOverrides, ...next };
    },

    addSelectors(next: Record<string, AnyFunction>) {
      selectors = { ...selectors, ...next } as SelectorsMap<S>;
    },

    addCommandOverrides(next: Record<string, string>) {
      commandOverrides = { ...commandOverrides, ...next };
    },

    addCommandsFactory(factory: GenericCommandFactory) {
      commandFactories.push(factory);
    },

    inherit(parent: InheritableComponentBehavior) {
      events = { ...parent.events, ...events };
      eventMetadata = { ...parent.eventMetadata, ...eventMetadata };
      eventOverrides = { ...parent.eventOverrides, ...eventOverrides };
      selectors = { ...(parent.selectors as SelectorsMap<S>), ...selectors };
      commandOverrides = { ...parent.commandOverrides, ...commandOverrides };
      commandFactories = [parent.commandsFactory, ...commandFactories];
    },

    getCommandsFactory() {
      return composeCommandFactories(commandFactories);
    },

    getSnapshot(): ComponentBehaviorSnapshot<S> {
      return {
        events,
        eventMetadata,
        eventOverrides,
        selectors,
        commandOverrides
      };
    }
  };
}

// SAFETY: `any` required for variadic argument forwarding in fluent builder pattern
type FluentUpdaterMap = Record<string, (...args: any[]) => void>;

export function bindFluentMethods<TBuilder extends Record<string, unknown>, TUpdaters extends FluentUpdaterMap>(
  builder: TBuilder,
  updaters: TUpdaters
): TBuilder & { [K in keyof TUpdaters]: (...args: Parameters<TUpdaters[K]>) => TBuilder } {
  const mutableBuilder = builder as Record<string, unknown>;

  Object.keys(updaters).forEach((key) => {
    const methodName = key as keyof TUpdaters;
    mutableBuilder[methodName as string] = (...args: unknown[]) => {
      updaters[methodName]!(...args);
      return builder;
    };
  });

  return builder as TBuilder & { [K in keyof TUpdaters]: (...args: Parameters<TUpdaters[K]>) => TBuilder };
}
