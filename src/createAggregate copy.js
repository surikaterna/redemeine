"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAggregate = void 0;
const wrapApplyer = (applyer) => {
    return (a) => {
        applyer(null, a);
    };
};
function createAggregate(def) {
    // const res = Object.keys(def.events).map((key) => {
    //   return { [key]: wrapApplyer(def.events[key]) };
    // });
    const initialState = def.initialState;
    const { name } = def;
    const commands = {};
    const projectorNames = Object.keys(def.commands);
    projectorNames.forEach((projectorName) => {
        commands[projectorName] = def.commands[projectorName];
    });
    return {
        name,
        commands: def.commands
    };
}
exports.createAggregate = createAggregate;
