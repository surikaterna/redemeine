import { Event, Command, CommandResult, EventCommandLink, EnvelopeHeaders, PluginExtensions } from './types';
import { ReadonlyDeep } from './utils/types/ReadonlyDeep';
import { formatCommandType } from './utils/naming';
import { GenericCommandMap, resolveCommandHandler } from './redemeineComponent';
import { createReadonlyDeepProxy } from './utils/readonlyProxy';
import { createIdentity } from './identity';

type NormalizedCommandExecutionResult<TPlugins extends PluginExtensions = {}> = {
    events: Event[];
    intents: Record<string, unknown> & TPlugins['intents'];
};

type CommandHandler<S, TPlugins extends PluginExtensions = {}> = (
    state: ReadonlyDeep<S>,
    payload: unknown
) => Event | CommandResult<Event, TPlugins>;

export function normalizeCommandExecutionResult<TPlugins extends PluginExtensions = {}>(
    result: Event | CommandResult<Event, TPlugins>
): NormalizedCommandExecutionResult<TPlugins> {
    if (Array.isArray(result)) {
        return {
            events: result,
            intents: {} as Record<string, unknown> & TPlugins['intents']
        };
    }

    if (result && typeof result === 'object' && 'events' in result && Array.isArray((result as { events?: unknown }).events)) {
        const { events, ...rest } = result as { events: Event[] } & Record<string, unknown>;
        return {
            events,
            intents: rest as Record<string, unknown> & TPlugins['intents']
        };
    }

    return {
        events: [result as Event],
        intents: {} as Record<string, unknown> & TPlugins['intents']
    };
}

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
        acc[commandType] = resolveCommandHandler<S>(allCommandsMap[key]) as unknown as CommandHandler<S>;
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
        const normalized = normalizeCommandExecutionResult(result);
        const linkedEvents = normalized.events.map(event => withCommandLink(event, commandWithId));
        Object.defineProperty(linkedEvents, '__intents', {
            value: normalized.intents,
            enumerable: false,
            configurable: true,
            writable: false
        });
        return linkedEvents;
    };
}
