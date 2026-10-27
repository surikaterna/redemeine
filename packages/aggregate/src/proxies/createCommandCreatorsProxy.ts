import { createCommand, type NamingStrategy } from '@redemeine/kernel';
import type { GenericCommandMap } from '../redemeineComponent';
import { createCommandPayload } from '../redemeineComponent';

export function createCommandCreatorsProxy(
    aggregateName: string,
    allCommandsMap: GenericCommandMap,
    allCommandOverrides: Record<string, string>,
    namingStrategy: NamingStrategy
) {
    return new Proxy({ ...allCommandsMap }, {
        get: (_, prop) => {
            if (typeof prop !== 'string' || !Object.hasOwn(allCommandsMap, prop)) return undefined;
            const explicitType = allCommandOverrides[prop] || namingStrategy.command(aggregateName, prop);
            const cmdDef = allCommandsMap[prop];
            return typeof cmdDef !== 'undefined'
                ? (...args: unknown[]) => createCommand(explicitType)(createCommandPayload(cmdDef, args) as never)
                : createCommand(explicitType);
        }
    });
}
