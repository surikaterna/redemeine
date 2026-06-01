import { type Event, type Command, type CommandResult, type EventCommandLink, type EnvelopeHeaders, type PluginExtensions, type PluginIntents, type ReadonlyDeep, createReadonlyDeepProxy, createIdentity, type Contract, ContractError } from '@redemeine/kernel';
import type { GenericCommandMap } from './redemeineComponent';
import { resolveCommandHandler } from './redemeineComponent';
import { formatCommandType } from './naming';

type NormalizedCommandExecutionResult<TPlugins extends PluginExtensions = {}> = {
    events: Event[];
    intents: PluginIntents<TPlugins>;
};

type CommandHandler<S> = (
    state: ReadonlyDeep<S>,
    payload: unknown
) => Event | Event[] | { events: Event[]; intents?: Record<string, unknown> };

export function normalizeCommandExecutionResult<TPlugins extends PluginExtensions = {}>(
    result: Event | CommandResult<Event, TPlugins>
): NormalizedCommandExecutionResult<TPlugins> {
    const emptyIntents = () => undefined as unknown as PluginIntents<TPlugins>;

    if (Array.isArray(result)) {
        return {
            events: result,
            intents: emptyIntents()
        };
    }

    if (result && typeof result === 'object' && 'events' in result && Array.isArray((result as { events?: unknown }).events)) {
        const { events, intents } = result as { events: Event[]; intents?: PluginIntents<TPlugins> };
        return {
            events,
            intents: (intents ?? emptyIntents()) as PluginIntents<TPlugins>
        };
    }

    return {
        events: [result as Event],
        intents: emptyIntents()
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
    commandHandlerByType?: Record<string, CommandHandler<S>>,
    contract?: Contract
) {
    const handlerByType: Record<string, CommandHandler<S>> = commandHandlerByType || Object.keys(allCommandsMap).reduce((acc, key) => {
        const commandType = allCommandOverrides[key] || formatCommandType(aggregateName, key);
        acc[commandType] = resolveCommandHandler<S>(allCommandsMap[key]!) as unknown as CommandHandler<S>;
        return acc;
    }, {} as Record<string, CommandHandler<S>>);

    return (state: S, command: Command<unknown, string>): Event[] => {
        const commandWithId = ensureCommandId(command);
        const commandType = commandWithId.type;
        const payload = commandWithId.payload;
        const handler = handlerByType[commandType];
        if (!handler) throw new Error('Unknown command: ' + commandType);

        if (contract) {
            const schema = contract.getCommand(commandType);
            if (schema) {
                const result = schema.safeParse(payload);
                if (!result.success) {
                    throw new ContractError(
                        `Command "${commandType}" payload failed validation: ${result.error.message}`
                    );
                }
            }
        }
        
        const readonlyState = createReadonlyDeepProxy(state);
        const result = handler(readonlyState as ReadonlyDeep<S>, payload);
        const normalized = normalizeCommandExecutionResult(result as Event | CommandResult<Event, PluginExtensions>);
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
