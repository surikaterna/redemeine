"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEvent = void 0;
const createEvent = (type, preparePayload) => {
    return (payload) => {
        const cmd = { type };
        const p = typeof preparePayload == 'function' ? preparePayload(payload) : { payload };
        return { type, payload: p.payload };
    };
};
exports.createEvent = createEvent;
