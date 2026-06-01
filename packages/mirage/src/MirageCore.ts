import { type Command, type Event, type CommandInterceptorContext, type PluginIntents, type RedemeinePlugin, RedemeinePluginHookError, type Contract, type ReadonlyDeep, createReadonlyDeepProxy } from '@redemeine/kernel';
import type { BuiltAggregate } from '@redemeine/aggregate';
import type { DispatchResult } from './mirage.types';

export const wrapPluginHookFailure = (
    plugin: RedemeinePlugin<any>,
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

export const assertPluginHasKey = (plugin: RedemeinePlugin<any>): void => {
    if (!plugin.key || typeof plugin.key !== 'string') {
        throw new Error('Invalid plugin configuration: plugin.key is required and must be a non-empty string.');
    }
};

export const hasHydrateEventPlugins = (plugins: RedemeinePlugin<any>[]): boolean => {
    return plugins.some((plugin) => typeof plugin.onHydrateEvent === 'function');
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
    private listeners: ((state: S) => void)[] = [];
    private plugins: RedemeinePlugin<any>[];
    private hasBeforeCommandPlugins: boolean;

    public get uncommitted(): Event[] {
        return this.pendingResults.events;
    }

    private getResultIntents(events: Event[]): PluginIntents<any> {
        const intents = (events as Event[] & { __intents?: Record<string, unknown> }).__intents;
        return intents && typeof intents === 'object' ? intents : {} as PluginIntents<any>;
    }

    constructor(
        public builder: BuiltAggregate<S, any, any, any>,
        public id: string,
        public state: S,
        public contract?: Contract,
        public strict: boolean = false,
        plugins: RedemeinePlugin<any>[] = []
    ) {
        this.plugins = plugins;
        this.plugins.forEach(assertPluginHasKey);
        this.hasBeforeCommandPlugins = plugins.some((plugin) => typeof plugin.onBeforeCommand === 'function');
    }

    private async runBeforeCommandInterceptors(command: Command<any, string>): Promise<void> {
        const commandMetaRegistry = this.builder.metadata?.commands || {};
        const ctx: CommandInterceptorContext<{}, unknown> = {
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

    private executeCommand(command: Command<any, string>): S {
        if (this.builder.hooks?.onBeforeCommand) {
            this.builder.hooks.onBeforeCommand(command, createReadonlyDeepProxy(this.state) as any);
        }

        if (this.contract) {
            this.validateCommand(command);
        }

        const events = this.builder.process(this.state, command);

        if (this.builder.hooks?.onAfterCommand) {
            this.builder.hooks.onAfterCommand(command, events, createReadonlyDeepProxy(this.state) as any);
        }

        this.applyEvents(events);
        this.version++;
        this.notify();
        return this.state;
    }

    private processAndApply(command: Command<any, string>): S {
        return this.executeCommand(command);
    }

    private async dispatchWithPlugins(command: Command<any, string>): Promise<S> {
        await this.runBeforeCommandInterceptors(command);
        return this.executeCommand(command);
    }

    private validateCommand(command: Command<any, string>): void {
        try {
            this.contract!.validateCommand(command.type, command.payload);
        } catch (err: any) {
            if (err.message.includes('schema not found')) {
                if (this.strict) throw err;
                console.warn(err.message);
            } else {
                throw err;
            }
        }
    }

    private applyEvents(events: Event[]): void {
        for (const ev of events) {
            if (this.contract) {
                try {
                    this.contract.validateEvent(ev.type, ev.payload);
                } catch (err: any) {
                    if (err.message.includes('schema not found')) {
                        if (this.strict) throw err;
                        console.warn(err.message);
                    } else {
                        throw err;
                    }
                }
            }
            this.state = this.builder.apply(this.state, ev);
            this.pendingResults.events.push(ev);
            if (this.builder.hooks?.onEventApplied) {
                this.builder.hooks.onEventApplied(ev, createReadonlyDeepProxy(this.state) as any);
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

    public subscribe(listener: (state: S) => void) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    public notify() {
        this.listeners.forEach(l => l(this.state));
    }

    public dispatch(cmd: any): DispatchResult<S> {
        const command = cmd as Command<any, string>;

        if (this.hasBeforeCommandPlugins) {
            return this.dispatchWithPlugins(command);
        }

        return this.processAndApply(command);
    }
}
