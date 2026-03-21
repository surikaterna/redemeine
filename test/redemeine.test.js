"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
(0, globals_1.describe)('Depot', () => {
    (0, globals_1.test)('return object', () => {
        class DD {
            findOne() {
                return {};
            }
            find(query) {
                throw new Error('Method not implemented.');
            }
            save(aggregate) {
                throw new Error('Method not implemented.');
            }
        }
        const dd = new DD();
        (0, globals_1.expect)(dd.findOne()).toBeTruthy();
    });
});
