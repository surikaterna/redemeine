const fs = require('fs');
const originalCode = import { createCommand } from '../createCommand';
import { NamingStrategy } from '../types';

export function createCommandCreatorsProxy(
    aggregateName: string,
    allCommandsMap: Record<string, any>,
    allCommandOverrides: Record<string, string>,
    namingStrategy: NamingStrategy
) {
    return new Proxy(allCommandsMap, {
        get: (_, prop: string) => {
            if (!(prop in allCommandsMap)) {
                return (id: string) => new Proxy({}, {
                    get: (__, cmdProp: string) => {
                        const entityPath = prop.replace(/s$/, '').replace(/([A-Z])/g, '_').toLowerCase();
                        const explicitType = namingStrategy.command(aggregateName, cmdProp, entityPath);
                        return (...args: any[]) => {
                            const cmdDef = allCommandsMap[aggregateName + prop.charAt(0).toUpperCase() + prop.slice(1)];
                            const payload = (cmdDef && typeof cmdDef !== 'function' && cmdDef.pack)
                                ? cmdDef.pack(...args)
                                : { ...args[0], id };
                            return createCommand(explicitType)(payload);
                        };
                    }
                });
            }
            const explicitType = allCommandOverrides[prop] || namingStrategy.command(aggregateName, prop);
            const cmdDef = allCommandsMap[prop];
            return typeof cmdDef !== 'function' && cmdDef.pack
                ? (...args: any[]) => createCommand(explicitType)(cmdDef.pack(...args))
                : createCommand(explicitType);
        }
    });
}
;
fs.writeFileSync('src/proxies/createCommandCreatorsProxy.ts', originalCode);
