type AggregateType = `${string}`;
export type CommandType = `${AggregateType}.${string}.command`;

export interface Command<P = void, T extends CommandType = CommandType> {
  type: T;
  payload: P;
}

export type PrepareCommand<P> = (...args: any[]) => { payload: P };

export type Commands<T extends keyof any = string, P extends any = any> = Record<T, () => Command<P>>;

type IfPrepareCommandFunctionProvided<PC extends PrepareCommand<any> | void, True, False> = PC extends (...args: any[]) => any ? True : False;

export type CommandFactory<P = void, T extends CommandType = CommandType, PC extends PrepareCommand<P> | void = void> = IfPrepareCommandFunctionProvided<
  PC,
  PC,
  (payload: P) => Command<P, T>
>;

export function createCommand<P = void, T extends CommandType = CommandType>(type: T): CommandFactory<P, T>;
export function createCommand<PC extends PrepareCommand<any>, T extends CommandType = CommandType>(
  type: T,
  prepareCommand: PC
): CommandFactory<ReturnType<PC>['payload'], T, PC>;

export function createCommand(type: string, prepareCommand?: Function): any {
  function commandFactory(...args: any[]) {
    if (prepareCommand) {
      let prepared = prepareCommand(...args);
      if (!prepared) {
        throw new Error('prepareCommand did not return an object');
      }
      return {
        type,
        payload: prepared.payload
      };
    }
    return {
      type,
      payload: args[0]
    };
  }
  commandFactory.toString = () => `${type}`;
  commandFactory.type = type;

  return commandFactory;
}
