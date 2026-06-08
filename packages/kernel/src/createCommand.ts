import type { Command, CommandType, EnvelopeHeaders } from './types';
import { createIdentity } from './identity';

/**
 * Callback that transforms factory arguments into a command payload shape.
 *
 * @since 0.1.0
 */
export type PrepareCommand<P> = (...args: unknown[]) => { payload: P; headers?: EnvelopeHeaders };

/**
 * A compiled command factory with introspectable `.type` property.
 *
 * @since 0.1.0
 */
export type CommandFactory<P = void, T extends CommandType | string = CommandType> =
    ((payload: P) => Command<P, T>) & { type: T, toString: () => T };

/**
 * A command factory that uses a prepare function to transform arguments.
 *
 * @since 0.1.0
 */
export type PreparedCommandFactory<PC extends PrepareCommand<unknown>, T extends CommandType | string = CommandType> =
    ((...args: Parameters<PC>) => Command<ReturnType<PC>['payload'], T>) & { type: T, toString: () => T };

/**
 * Creates a typed command factory for producing domain commands.
 *
 * The returned factory generates commands with unique IDs and the specified type.
 * Optionally accepts a `prepareCommand` function to transform arguments into
 * the command payload.
 *
 * @example
 * ```typescript
 * const placeOrder = createCommand<{ item: string }>('order.place.command');
 * const cmd = placeOrder({ item: 'widget' });
 * // => { id: '...', type: 'order.place.command', payload: { item: 'widget' } }
 * ```
 *
 * @param type - The canonical command type identifier
 * @param prepareCommand - Optional transform to build payload from factory arguments
 * @returns A command factory function with a `.type` property for introspection
 * @since 0.1.0
 */

export function createCommand<P = void, T extends CommandType | string = CommandType>(type: T): CommandFactory<P, T>;
export function createCommand<PC extends PrepareCommand<unknown>, T extends CommandType | string = CommandType>(
    type: T,
    prepareCommand: PC
): PreparedCommandFactory<PC, T>;

export function createCommand(type: string, prepareCommand?: Function) {   
    function commandFactory(...args: unknown[]) {
        const id = createIdentity();
        if (prepareCommand) {
            const prepared = prepareCommand(...args);
            if (!prepared) {
                throw new Error('prepareCommand did not return an object with a payload');
            }
            return {
                id,
                type,
                payload: prepared.payload,
                ...(prepared.headers !== undefined ? { headers: prepared.headers } : {})
            };
        }
        return { id, type, payload: args[0] };
    }
    
    // Allow the factory itself to be introspected for its type
    commandFactory.toString = () => type;
    commandFactory.type = type;

    return commandFactory;
}
