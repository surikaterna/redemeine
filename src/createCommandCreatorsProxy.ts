import { createCommand } from './createCommand';
import { formatCommandType } from './naming';

export function createCommandCreatorsProxy(
    aggregateName: string,
    allCommandsMap: Record<string, Function>,
    allCommandOverrides: Record<string, string>
) {
    return new Proxy(allCommandsMap, {
        get: (_, prop: string) => {
            const explicitType = allCommandOverrides[prop] || formatCommandType(aggregateName, prop);
            return createCommand(explicitType);
        }
    });
}
