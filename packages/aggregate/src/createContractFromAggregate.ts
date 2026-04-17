import { Contract } from '@redemeine/kernel';
import type { ZodType } from 'zod';

/**
 * Bridges aggregate handler names to their resolved type strings,
 * wiring Zod schemas into a Contract without manual type-string mapping.
 *
 * Schemas are keyed by the same camelCase names used in `.commands()` and `.events()`.
 * The aggregate's `types` map (populated at build time) resolves each key to its
 * full dot-notation type string (e.g. `register` → `attachment.register.command`).
 */
export function createContractFromAggregate<S>(
    aggregate: { types: { commands: Record<string, string>; events: Record<string, string> } },
    schemas: {
        commands?: Record<string, ZodType>;
        events?: Record<string, ZodType>;
        state?: ZodType;
    }
): Contract {
    const contract = new Contract();

    if (schemas.commands) {
        for (const [key, schema] of Object.entries(schemas.commands)) {
            const typeString = aggregate.types.commands[key];
            if (typeString) {
                contract.addCommand(typeString, schema);
            }
        }
    }

    if (schemas.events) {
        for (const [key, schema] of Object.entries(schemas.events)) {
            const typeString = aggregate.types.events[key];
            if (typeString) {
                contract.addEvent(typeString, schema);
            }
        }
    }

    if (schemas.state) {
        contract.setStateSchema(schemas.state);
    }

    return contract;
}
