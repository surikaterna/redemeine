"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCommandProcessor = void 0;
//order.cancel.command -> order.cancelled.event
function createCommandProcessor(command) {
    return {
        type: 'a.b.event',
        payload: undefined
    };
}
exports.createCommandProcessor = createCommandProcessor;
