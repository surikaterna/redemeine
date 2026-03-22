import zodToJsonSchema from 'zod-to-json-schema';
import { Contract } from './Contract';

export function describeContract(contract: Contract, aggregateName: string = 'aggregate') {
    const commands: Record<string, any> = {};
    const events: Record<string, any> = {};

    for (const [type, schema] of contract.commands.entries()) {
        commands[type] = zodToJsonSchema(schema, type).definitions?.[type] || {};
    }

    for (const [type, schema] of contract.events.entries()) {
        events[type] = zodToJsonSchema(schema, type).definitions?.[type] || {};
    }

    let state = {};
    if (contract.stateSchema) {
        state = zodToJsonSchema(contract.stateSchema, 'state').definitions?.['state'] || {};
    }

    return {
        aggregate: aggregateName,
        commands,
        events,
        state
    };
}
