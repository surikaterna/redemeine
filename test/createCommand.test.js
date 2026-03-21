"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const createCommand_1 = require("../src/createCommand");
(0, globals_1.describe)('createCommand', () => {
    (0, globals_1.test)('returns function', () => {
        const cmd = (0, createCommand_1.createCommand)('order.cancel.command');
        (0, globals_1.expect)(typeof cmd == 'function').toBeTruthy();
    });
    (0, globals_1.test)('returns string payload', () => {
        const cmd = (0, createCommand_1.createCommand)('order.cancel.command');
        (0, globals_1.expect)(cmd('yep').payload).toBe('yep');
    });
    (0, globals_1.test)('returns number payload', () => {
        const cmd = (0, createCommand_1.createCommand)('order.cancel.command');
        (0, globals_1.expect)(cmd(12).payload).toBe(12);
    });
    (0, globals_1.test)('returns complex payload', () => {
        const cmd = (0, createCommand_1.createCommand)('order.comment.command');
        const payload = { remark: 'hello', list: ['1', 'other'] };
        (0, globals_1.expect)(cmd(payload).payload).toBe(payload);
        (0, globals_1.expect)(cmd(payload).type).toBe('order.comment.command');
    });
    (0, globals_1.test)('returns prepared payload', () => {
        const cmd = (0, createCommand_1.createCommand)('order.hello.command', (text, user, age) => {
            return {
                headers: { dummy: true },
                payload: {
                    text,
                    user,
                    age
                }
            };
        });
        (0, globals_1.expect)(cmd('hello', 'world', 12).payload).toEqual({ text: 'hello', user: 'world', age: 12 });
    });
});
