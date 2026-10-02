import { z } from 'zod';
import type { Contract } from '@redemeine/kernel';

export function describeContract(contract: Contract, aggregateName: string = 'aggregate') {
    const commands: Record<string, unknown> = {};
    const events: Record<string, unknown> = {};

    for (const [type, schema] of contract.commands.entries()) {
        commands[type] = jsonSchema(schema);
    }

    for (const [type, schema] of contract.events.entries()) {
        events[type] = jsonSchema(schema);
    }

    let state = {};
    if (contract.stateSchema) {
        state = jsonSchema(contract.stateSchema);
    }

    return {
        aggregate: aggregateName,
        commands,
        events,
        state
    };
}

function jsonSchema(schema: unknown) {
    if (!(schema instanceof z.ZodType)) throw new TypeError('Contract schemas must be Zod 4 schemas.');
    return z.toJSONSchema(schema);
}
