"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCommand = void 0;
function createCommand(type, prepareCommand) {
    function commandFactory(...args) {
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
exports.createCommand = createCommand;
