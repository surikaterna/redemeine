import { createCommand } from './createCommand';

export function createCommandCreatorsProxy(
    aggregateName: string,
    allCommandsMap: Record<string, Function>,
    allCommandOverrides: Record<string, string>
) {
    return new Proxy(allCommandsMap, {
        get: (_, prop: string) => {
            const explicitType = allCommandOverrides[prop] || aggregateName + '.' + prop + '.command';
            return createCommand(explicitType);
        }
    });
}
