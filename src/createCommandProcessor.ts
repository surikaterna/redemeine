import { Event, Command } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { formatCommandType } from './utils/naming';
import { GenericCommandMap, resolveCommandHandler } from './redemeineComponent';

export function createCommandProcessor<S>(
    aggregateName: string,
    allCommandsMap: GenericCommandMap,
    allCommandOverrides: Record<string, string>
) {
    return (state: S, command: Command<unknown, string>): Event[] => {
        const commandType = command.type;
        const payload = command.payload;
        const commandKey = Object.keys(allCommandsMap).find(key =>
            (allCommandOverrides[key] || formatCommandType(aggregateName, key)) === commandType
        );

        if (!commandKey) throw new Error('Unknown command: ' + commandType); 

        const cmdDef = allCommandsMap[commandKey];
        const handler = resolveCommandHandler<S>(cmdDef);
        
        const result = handler(state as ReadonlyDeep<S>, payload);
        return Array.isArray(result) ? result : [result];
    };
}
