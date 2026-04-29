import { z } from 'zod';
import type { Contract } from '@redemeine/kernel';

export function describeContract(contract: Contract, aggregateName: string = 'aggregate') {
    const commands: Record<string, any> = {};
    const events: Record<string, any> = {};

    for (const [type, schema] of contract.commands.entries()) {
        commands[type] = z.toJSONSchema(schema as z.ZodType);
    }

    for (const [type, schema] of contract.events.entries()) {
        events[type] = z.toJSONSchema(schema as z.ZodType);
    }

    let state = {};
    if (contract.stateSchema) {
        state = z.toJSONSchema(contract.stateSchema as z.ZodType);
    }

    return {
        aggregate: aggregateName,
        commands,
        events,
        state
    };
}
