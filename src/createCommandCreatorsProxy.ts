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
            if (!(prop in allCommandsMap)) {
                return (id: string) => new Proxy({}, {
                    get: (__, cmdProp: string) => {
                        const entityPath = prop.replace(/s$/, '').replace(/([A-Z])/g, '_$1').toLowerCase();
                        const explicitType = namingStrategy.command(aggregateName, cmdProp, entityPath);
                        return (payload: any) => createCommand(explicitType)({ ...payload, id });
                    }
                });
            }
            const explicitType = allCommandOverrides[prop] || namingStrategy.command(aggregateName, prop);
            return createCommand(explicitType);
        }
    });
}
