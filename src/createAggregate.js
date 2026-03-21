"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAggregate = void 0;
const immer_1 = require("immer");
function createAggregate(spec) {
    const res = { commands: {}, projectors: {} };
    const cmd = spec.commands || [];
    /**
     * Create commands
     */
    Object.keys(cmd).forEach((c) => (res.commands[c] = (a) => cmd[c]));
    Object.keys(spec.events).forEach((e) => {
        if (typeof e !== 'function') {
            Object.keys(spec.events[e]).forEach((commandKey) => {
                if (commandKey !== 'project') {
                    res.commands[commandKey] = spec.events[e][commandKey];
                }
            });
        }
    });
    /**
     * Create projectors
     */
    Object.keys(spec.events).forEach((e) => {
        const eventDef = spec.events[e];
        if (typeof eventDef === 'function') {
            res.projectors[e] = (state, event) => (0, immer_1.produce)(state, (draft) => eventDef(draft, event));
        }
        else {
            Object.keys(eventDef).forEach((key) => {
                if (key === 'project') {
                    res.projectors[e] = (state, event) => (0, immer_1.produce)(state, (draft) => eventDef[key](draft, event));
                }
            });
        }
    });
    return res;
}
exports.createAggregate = createAggregate;
