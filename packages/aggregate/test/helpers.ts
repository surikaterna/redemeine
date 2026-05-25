/**
 * Minimal test-only mirage replacement for exercising aggregate definitions
 * without depending on @redemeine/mirage.
 */
import { isMirageContextBinding, MirageContextSymbol } from '../src/bindContext';

type BuiltAggregate = {
  aggregateType: string;
  initialState: any;
  process: (state: any, command: any) => any[];
  apply: (state: any, event: any) => any;
  commandCreators: Record<string, (...args: any[]) => { type: string; payload: any }>;
  selectors: Record<string, (state: any, ...args: any[]) => any>;
  mounts: Record<string, { kind: string; commandPrefix: string; statePath: string[]; pk?: string | readonly string[] }>;
  hooks?: {
    onBeforeCommand?: (...args: any[]) => void;
    onAfterCommand?: (...args: any[]) => void;
    onEventApplied?: (...args: any[]) => void;
  };
};

type TestMirageOptions = {
  events?: any[];
  snapshot?: any;
};

/**
 * Creates a test mirage — a mutable proxy over a built aggregate that
 * dispatches commands synchronously and exposes state + selectors.
 */
export function createTestMirage<T extends BuiltAggregate>(
  aggregate: T,
  id: string,
  options?: TestMirageOptions
): any {
  let state: any;
  const uncommittedEvents: any[] = [];

  // Initialize state
  if (options?.snapshot) {
    state = { ...options.snapshot };
  } else {
    state = { ...aggregate.initialState };
  }

  // Hydrate from events
  if (options?.events) {
    for (const event of options.events) {
      state = aggregate.apply(state, event);
    }
  }

  function dispatch(commandType: string, payload: any): any {
    const command = { type: commandType, payload };

    // Run hooks
    aggregate.hooks?.onBeforeCommand?.(command, state);

    const events = aggregate.process(state, command);
    for (const event of events) {
      state = aggregate.apply(state, event);
      uncommittedEvents.push(event);
      aggregate.hooks?.onEventApplied?.(event, state);
    }

    aggregate.hooks?.onAfterCommand?.(command, state, events);
    return state;
  }

  // Build entity list proxies
  function createEntityListProxy(mountName: string, mount: any): any {
    const pk = mount.pk || 'id';
    const pkFields = Array.isArray(pk) ? pk : [pk];

    // Function that scopes to a specific entity by pk
    const scopeFn = (pkValue: any) => {
      const pkPayload: Record<string, unknown> = {};
      if (pkFields.length === 1 && typeof pkValue !== 'object') {
        pkPayload[pkFields[0]] = pkValue;
      } else {
        Object.assign(pkPayload, pkValue);
      }

      return new Proxy({}, {
        get(_target, prop: string) {
          // Find the matching command
          const prefixed = mountName + prop.charAt(0).toUpperCase() + prop.slice(1);
          const creator = aggregate.commandCreators[prefixed];
          if (creator) {
            return (...args: any[]) => {
              // Inject pk value as first arg
              const cmd = creator(pkValue, ...args);
              return dispatch(cmd.type, cmd.payload);
            };
          }
          // State access - find the entity in the list
          const list = state[mountName] || [];
          const entity = list.find((e: any) => {
            return pkFields.every((f: string) => e[f] === pkPayload[f]);
          });
          return entity?.[prop];
        }
      });
    };

    // The proxy acts as both array-like and function
    return new Proxy(scopeFn, {
      get(_target, prop: string) {
        const list = state[mountName] || [];
        if (prop === 'length') return list.length;
        if (prop === Symbol.iterator as any) return list[Symbol.iterator].bind(list);
        const idx = Number(prop);
        if (!isNaN(idx)) {
          const item = list[idx];
          if (!item) return undefined;
          // Return a scoped proxy for this item
          const pkValue = pkFields.length === 1 ? item[pkFields[0]] : Object.fromEntries(pkFields.map((f: string) => [f, item[f]]));
          const scoped = scopeFn(pkValue);
          // Also expose state properties
          return new Proxy(scoped, {
            get(target, p: string) {
              if (p in item) return item[p];
              return (target as any)[p];
            }
          });
        }
        // Array methods
        if (typeof list[prop] === 'function') {
          return list[prop].bind(list);
        }
        return list[prop];
      },
      apply(_target, _thisArg, args) {
        return scopeFn(args[0]);
      }
    });
  }

  function createEntityMapProxy(mountName: string): any {
    return new Proxy({}, {
      get(_target, prop: string) {
        const map = state[mountName] || {};
        if (prop in map) {
          const item = map[prop];
          // Return scoped proxy with commands + state
          return new Proxy({}, {
            get(_t, cmdProp: string) {
              if (cmdProp in item) return item[cmdProp];
              const prefixed = mountName + cmdProp.charAt(0).toUpperCase() + cmdProp.slice(1);
              const creator = aggregate.commandCreators[prefixed];
              if (creator) {
                return (...args: any[]) => {
                  const cmd = creator(prop, ...args);
                  return dispatch(cmd.type, cmd.payload);
                };
              }
              return undefined;
            }
          });
        }
        return undefined;
      }
    });
  }

  // Main proxy
  const proxy = new Proxy({} as any, {
    get(_target, prop: string) {
      // Uncommitted events extraction
      if (prop === '__uncommittedEvents') return uncommittedEvents;

      // Check mounts first
      if (prop in aggregate.mounts) {
        const mount = aggregate.mounts[prop];
        if (mount.kind === 'list') {
          return createEntityListProxy(prop, mount);
        }
        if (mount.kind === 'map') {
          return createEntityMapProxy(prop);
        }
        // valueObject/valueObjectList/valueObjectMap - return state directly
        return state[prop];
      }

      // Selectors
      if (prop in aggregate.selectors) {
        const selector = aggregate.selectors[prop];
        // Return a function that calls the selector with current state
        return (...args: any[]) => {
          const result = selector(state, ...args);
          // If result is a MirageContextBinding, unwrap it
          if (isMirageContextBinding(result)) {
            return unwrapContextBinding(result);
          }
          // If result is an array, add .first() helper and wrap items with entity commands
          if (Array.isArray(result)) {
            const wrapped = result.map((item: any) => {
              if (item && typeof item === 'object' && 'id' in item) {
                return createEntityItemProxy(item, null);
              }
              return item;
            });
            (wrapped as any).first = () => wrapped[0];
            return wrapped;
          }
          return result;
        };
      }

      // Commands
      if (prop in aggregate.commandCreators) {
        return (...args: any[]) => {
          const cmd = aggregate.commandCreators[prop](...args);
          return dispatch(cmd.type, cmd.payload);
        };
      }

      // State access
      if (state && prop in state) {
        return state[prop];
      }

      return undefined;
    }
  });

  function unwrapContextBinding(binding: any): any {
    const ctx = binding[MirageContextSymbol];
    if (ctx.kind === 'polymorphic') {
      const { data, discriminatorKey, roleMap } = ctx;
      const items = Array.isArray(data) ? data : [];
      return items.map((item: any) => {
        // Resolve discriminator value via dot path
        const discValue = discriminatorKey.split('.').reduce((o: any, k: string) => o?.[k], item);
        const role = roleMap[discValue];
        return createEntityItemProxy(item, role);
      });
    }
    // single binding
    return createEntityItemProxy(ctx.data, ctx.role);
  }

  function createEntityItemProxy(itemState: any, role: any): any {
    // role is an EntityPackage with commandFactory
    // We need to find the matching mount and dispatch commands through the aggregate
    return new Proxy({}, {
      get(_target, prop: string) {
        // State access
        if (prop in itemState) return itemState[prop];
        // Command dispatch — find matching entity list mount command
        for (const [mountName, mount] of Object.entries(aggregate.mounts)) {
          if (mount.kind === 'list') {
            const prefixed = mountName + prop.charAt(0).toUpperCase() + prop.slice(1);
            const creator = aggregate.commandCreators[prefixed];
            if (creator) {
              const pkField = (Array.isArray(mount.pk) ? mount.pk[0] : mount.pk) || 'id';
              return (...args: any[]) => {
                // No args: object-style (payload with pk); with args: positional
                const cmd = args.length === 0
                  ? creator({ [pkField]: itemState[pkField] })
                  : creator(itemState[pkField], ...args);
                return dispatch(cmd.type, cmd.payload);
              };
            }
          }
        }
        return undefined;
      }
    });
  }

  return proxy;
}

/**
 * Extract uncommitted events from a test mirage instance.
 */
export function extractUncommittedEvents(mirage: any): any[] {
  return mirage.__uncommittedEvents || [];
}
