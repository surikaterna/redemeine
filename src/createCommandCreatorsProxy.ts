import { createCommand } from './createCommand';
import { NamingStrategy } from './types';

export function createCommandCreatorsProxy(
    aggregateName: string,
    allCommandsMap: Record<string, Function>,
    allCommandOverrides: Record<string, string>,
    namingStrategy: NamingStrategy
) {
    return new Proxy(allCommandsMap, {
        get: (_, prop: string) => {
            const explicitType = allCommandOverrides[prop] || namingStrategy.command(aggregateName, prop);
            return createCommand(explicitType);
        }
    });
}
