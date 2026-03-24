import { Event, Command } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { formatCommandType } from './utils/naming';
import { GenericCommandMap, resolveCommandHandler } from './redemeineComponent';
import { createReadonlyDeepProxy } from './utils/readonlyProxy';

type CommandHandler<S> = (state: ReadonlyDeep<S>, payload: unknown) => Event | Event[];

export function createCommandProcessor<S>(
    aggregateName: string,
    allCommandsMap: GenericCommandMap,
    allCommandOverrides: Record<string, string>,
    commandHandlerByType?: Record<string, CommandHandler<S>>
) {
    const handlerByType: Record<string, CommandHandler<S>> = commandHandlerByType || Object.keys(allCommandsMap).reduce((acc, key) => {
        const commandType = allCommandOverrides[key] || formatCommandType(aggregateName, key);
        acc[commandType] = resolveCommandHandler<S>(allCommandsMap[key]);
        return acc;
    }, {} as Record<string, CommandHandler<S>>);

    return (state: S, command: Command<unknown, string>): Event[] => {
        const commandType = command.type;
        const payload = command.payload;
        const handler = handlerByType[commandType];
        if (!handler) throw new Error('Unknown command: ' + commandType);
        
        const readonlyState = createReadonlyDeepProxy(state);
        const result = handler(readonlyState as ReadonlyDeep<S>, payload);
        return Array.isArray(result) ? result : [result];
    };
}
