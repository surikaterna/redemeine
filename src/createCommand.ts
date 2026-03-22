import { Command, CommandType } from './types';

/**
 * Foundational type defining a structural preparation callback before a command factory commits the payload.
 */
export type PrepareCommand<P> = (...args: any[]) => { payload: P };

/**
 * Foundational type representing a compiled factory that hydrates and dispatches typed commands.
 */
export type CommandFactory<P = void, T extends CommandType | string = CommandType> =
    ((payload: P) => Command<P, T>) & { type: T, toString: () => T };

/**
 * Foundational type for a compiled factory extending prepare-command behaviors.
 */
export type PreparedCommandFactory<PC extends PrepareCommand<any>, T extends CommandType | string = CommandType> =
    ((...args: Parameters<PC>) => Command<ReturnType<PC>['payload'], T>) & { type: T, toString: () => T };

export function createCommand<P = void, T extends CommandType | string = CommandType>(type: T): CommandFactory<P, T>;
export function createCommand<PC extends PrepareCommand<any>, T extends CommandType | string = CommandType>(
    type: T,
    prepareCommand: PC
): PreparedCommandFactory<PC, T>;

export function createCommand(type: string, prepareCommand?: Function): any {   
    function commandFactory(...args: any[]) {
        if (prepareCommand) {
            const prepared = prepareCommand(...args);
            if (!prepared) {
                throw new Error('prepareCommand did not return an object with a payload');
            }
            return { type, payload: prepared.payload };
        }
        return { type, payload: args[0] };
    }
    
    // Allow the factory itself to be introspected for its type
    commandFactory.toString = () => type;
    commandFactory.type = type;

    return commandFactory;
}
