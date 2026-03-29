import { createCommand } from '../createCommand';
import { NamingStrategy } from '../types';
import { GenericCommandMap, createCommandPayload } from '../redemeineComponent';

export function createCommandCreatorsProxy(
    aggregateName: string,
    allCommandsMap: GenericCommandMap,
    allCommandOverrides: Record<string, string>,
    namingStrategy: NamingStrategy
) {
    return new Proxy(allCommandsMap, {
        get: (_, prop: string) => {
            if (!(prop in allCommandsMap)) {
                return (id: string) => new Proxy({}, {
                    get: (__, cmdProp: string) => {
                        const entityPath = prop.replace(/s$/, '').replace(/([A-Z])/g, '_$1').toLowerCase();
                        const explicitType = namingStrategy.command(aggregateName, cmdProp, entityPath);
                        return (...args: unknown[]) => {
                            const cmdDef = allCommandsMap[aggregateName + prop.charAt(0).toUpperCase() + prop.slice(1)];
                            const firstArg = args[0];
                            const payload = cmdDef
                                ? (typeof cmdDef !== 'function' && 'pack' in cmdDef && typeof cmdDef.pack === 'function'
                                    ? createCommandPayload(cmdDef, args)
                                    : (typeof firstArg === 'object' && firstArg !== null
                                        ? { ...(firstArg as Record<string, unknown>), id }
                                        : { id }))
                                : (typeof firstArg === 'object' && firstArg !== null
                                    ? { ...(firstArg as Record<string, unknown>), id }
                                    : { id });
                            return createCommand(explicitType)(payload as never);
                        };
                    }
                });
            }
            const explicitType = allCommandOverrides[prop] || namingStrategy.command(aggregateName, prop);
            const cmdDef = allCommandsMap[prop];
            return typeof cmdDef !== 'undefined'
                ? (...args: unknown[]) => createCommand(explicitType)(createCommandPayload(cmdDef, args) as never)
                : createCommand(explicitType);
        }
    });
}
