import { Event, Command, EventCommandLink, EnvelopeHeaders } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { formatCommandType } from './utils/naming';
import { GenericCommandMap, resolveCommandHandler } from './redemeineComponent';
import { createReadonlyDeepProxy } from './utils/readonlyProxy';
import { createIdentity } from './identity';

type CommandHandler<S> = (state: ReadonlyDeep<S>, payload: unknown) => Event | Event[];

function ensureCommandId(command: Command<unknown, string>): Command<unknown, string> {
    if (command.id) {
        return command;
    }

    return {
        ...command,
        id: createIdentity()
    };
}

function withCommandLink(event: Event, command: Command<unknown, string>): Event {
    const commandLink: EventCommandLink<unknown, string> = {
        id: command.id,
        type: command.type
    };

    const commandHeaders = command.headers && typeof command.headers === 'object'
        ? command.headers as EnvelopeHeaders
        : undefined;

    if (commandHeaders && commandHeaders.commandSummary !== undefined) {
        commandLink.summary = commandHeaders.commandSummary;
    }

    if (commandHeaders && typeof commandHeaders.commandStoreRef === 'string') {
        commandLink.storeRef = commandHeaders.commandStoreRef;
    }

    const existingMetadata =
        event.metadata && typeof event.metadata === 'object' ? event.metadata : {};

    return {
        ...event,
        id: event.id || createIdentity(),
        metadata: {
            ...existingMetadata,
            command: commandLink
        }
    };
}

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
        const commandWithId = ensureCommandId(command);
        const commandType = commandWithId.type;
        const payload = commandWithId.payload;
        const handler = handlerByType[commandType];
        if (!handler) throw new Error('Unknown command: ' + commandType);
        
        const readonlyState = createReadonlyDeepProxy(state);
        const result = handler(readonlyState as ReadonlyDeep<S>, payload);
        const events = Array.isArray(result) ? result : [result];
        return events.map(event => withCommandLink(event, commandWithId));
    };
}
