import { Event, Command } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { formatCommandType } from './utils/naming';

export function createCommandProcessor<S>(
    aggregateName: string,
    allCommandsMap: Record<string, any>,
    allCommandOverrides: Record<string, string>
) {
    return (state: S, command: Command<any, string>): Event[] => {
        const commandType = command.type;
        const payload = command.payload;
        const commandKey = Object.keys(allCommandsMap).find(key =>
            (allCommandOverrides[key] || formatCommandType(aggregateName, key)) === commandType
        );

        if (!commandKey) throw new Error('Unknown command: ' + commandType); 

        const cmdDef = allCommandsMap[commandKey];
        const handler = typeof cmdDef === 'function' ? cmdDef : cmdDef.handler;
        
        const result = handler(state as ReadonlyDeep<S>, payload);
        return Array.isArray(result) ? result : [result];
    };
}
