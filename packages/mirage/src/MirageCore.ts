import { type Command as KernelCommand, type Event, type CommandInterceptorContext, RedemeinePluginHookError, type Contract, type ReadonlyDeep, createReadonlyDeepProxy } from '@redemeine/kernel';
import type { RuntimeBuilder, RuntimePlugin, RuntimeExtensions } from './runtimeDefinition';
import type { DispatchResult } from './mirage.types';
import { readonlySnapshot } from './stateViews';
type Command = KernelCommand<unknown, string>;

export const wrapPluginHookFailure = (
    plugin: RuntimePlugin,
    hook: 'onBeforeCommand' | 'onHydrateEvent' | 'onBeforeAppend' | 'onAfterCommit',
    aggregateId: string,
    cause: unknown
): RedemeinePluginHookError => {
    assertPluginHasKey(plugin);
    return new RedemeinePluginHookError({
        pluginKey: plugin.key,
        hook,
        aggregateId,
        cause
    });
};

export const assertPluginHasKey = (plugin: RuntimePlugin): void => {
    if (!plugin.key || typeof plugin.key !== 'string') {
        throw new Error('Invalid plugin configuration: plugin.key is required and must be a non-empty string.');
    }
};

export const hasHydrateEventPlugins = (plugins: RuntimePlugin[]): boolean => {
    return plugins.some((plugin) => typeof plugin.onHydrateEvent === 'function');
};

export const assertEventCount = (value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('initialVersion / snapshot.version must be a nonnegative safe integer event count.');
    }
};

export const assertCanAdvanceEventCount = (value: number): void => {
    if (!Number.isSafeInteger(value + 1)) {
        throw new RangeError('Mirage event count cannot exceed Number.MAX_SAFE_INTEGER.');
    }
};

/**
 * Handles "schema not found" errors from contract validation.
 * In strict mode, rethrows; otherwise logs a warning and swallows the error.
 */
const handleSchemaValidationError = (err: unknown, strict: boolean): void => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('schema not found')) {
        if (strict) throw err;
        console.warn(message);
    } else {
        throw err;
    }
};

/**
 * The internal core controller of a Mirage instance.
 * Tracks the uncommitted events, current version, and executes the core command routing.
 */
export class MirageCore<S> {
    private pendingResults: { events: Event[]; intents: Record<string, unknown> } = {
        events: [],
        intents: {}
    };
    public version: number = 0;
    private listeners: ((state: ReadonlyDeep<S>) => void)[] = [];
    private plugins: RuntimePlugin[];
    private hasBeforeCommandPlugins: boolean;

    public get uncommitted(): Event[] {
        return this.pendingResults.events;
    }

    private getResultIntents(events: Event[]): Record<string, unknown> {
        const intents = (events as Event[] & { __intents?: Record<string, unknown> }).__intents;
        return intents && typeof intents === 'object' ? intents : {};
    }

    constructor(
        public builder: RuntimeBuilder<S>,
        public id: string,
        public state: S,
        public contract?: Contract,
        public strict: boolean = false,
        plugins: RuntimePlugin[] = [],
        initialVersion: number = 0
    ) {
        this.version = initialVersion;
        this.plugins = plugins;
        this.plugins.forEach(assertPluginHasKey);
        this.hasBeforeCommandPlugins = plugins.some((plugin) => typeof plugin.onBeforeCommand === 'function');
    }

    private async runBeforeCommandInterceptors(command: Command): Promise<void> {
        const commandMetaRegistry = this.builder.metadata?.commands || {};
        const ctx: CommandInterceptorContext<RuntimeExtensions, unknown> = {
            pluginKey: '',
            aggregateId: this.id,
            commandType: command.type,
            payload: command.payload,
            meta: commandMetaRegistry[command.type]?.meta
        };

        for (const plugin of this.plugins) {
            if (typeof plugin.onBeforeCommand === 'function') {
                ctx.pluginKey = plugin.key;
                try {
                    await plugin.onBeforeCommand(ctx);
                } catch (error) {
                    throw wrapPluginHookFailure(plugin, 'onBeforeCommand', this.id, error);
                }
            }
        }
    }

    private executeCommand(command: Command): ReadonlyDeep<S> {
        if (this.builder.hooks?.onBeforeCommand) {
            this.builder.hooks.onBeforeCommand(command, this.stateView());
        }

        if (this.contract) {
            this.validateCommand(command);
        }

        // Decision code receives isolated data; only event application can replace live state.
        const events = this.builder.process(structuredClone(this.state), command);

        if (this.builder.hooks?.onAfterCommand) {
            this.builder.hooks.onAfterCommand(command, events, this.stateView());
        }

        this.applyEvents(events);
        this.notify();
        return this.stateView();
    }

    private processAndApply(command: Command): ReadonlyDeep<S> {
        return this.executeCommand(command);
    }

    private async dispatchWithPlugins(command: Command): Promise<ReadonlyDeep<S>> {
        await this.runBeforeCommandInterceptors(command);
        return this.executeCommand(command);
    }

    private validateCommand(command: Command): void {
        try {
            this.contract!.validateCommand(command.type, command.payload);
        } catch (err: unknown) {
            handleSchemaValidationError(err, this.strict);
        }
    }

    private applyEvents(events: Event[]): void {
        for (const ev of events) {
            if (this.contract) {
                try {
                    this.contract.validateEvent(ev.type, ev.payload);
                } catch (err: unknown) {
                    handleSchemaValidationError(err, this.strict);
                }
            }
            assertCanAdvanceEventCount(this.version);
            this.state = this.builder.apply(this.state, ev);
            this.pendingResults.events.push(ev);
            this.version++;
            if (this.builder.hooks?.onEventApplied) {
                this.builder.hooks.onEventApplied(ev, this.stateView());
            }
        }

        this.pendingResults.intents = {
            ...this.pendingResults.intents,
            ...this.getResultIntents(events)
        };
    }

    public getPendingResults(): { events: Event[]; intents: Record<string, unknown> } {
        return {
            events: [...this.pendingResults.events],
            intents: { ...this.pendingResults.intents }
        };
    }

    public clearPendingResults(): void {
        this.pendingResults = {
            events: [],
            intents: {}
        };
    }

    public stateView(): ReadonlyDeep<S> {
        return readonlySnapshot(this.state);
    }

    public subscribe(listener: (state: ReadonlyDeep<S>) => void) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    public notify() {
        if (!this.listeners.length) return;
        const view = this.stateView();
        this.listeners.forEach(l => l(view));
    }

    public dispatch(command: Command): DispatchResult<S> {
        if (!command || typeof command !== 'object' || typeof command.type !== 'string' || !('payload' in command)) {
            throw new TypeError('Dispatch requires a command envelope with type and payload');
        }

        command = this.prepareCommand(command);

        if (this.hasBeforeCommandPlugins) {
            return this.dispatchWithPlugins(command);
        }

        return this.processAndApply(command);
    }

    private prepareCommand(command: Command): Command {
        const { prepareCommand, aggregatePlugins } = this.builder;
        if (!prepareCommand || !aggregatePlugins?.some(plugin => plugin.commandEnvelope || plugin.eventEnvelope)) return command;
        for (const key of ['aggregateId', 'aggregateType']) {
            const value: unknown = Reflect.get(command, key);
            if (value !== undefined && typeof value !== 'string') throw new TypeError(`Invalid envelope routing field: ${key}`);
        }
        // Routing belongs to this instance; preserve the command identity and finalized scoped payload.
        return prepareCommand.call(this.builder, this.state, {
            ...command, aggregateId: this.id, aggregateType: this.builder.aggregateType
        });
    }
}
