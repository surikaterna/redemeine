import { Contract } from '@redemeine/kernel';
import { z } from 'zod';
import { describeContract } from '../src/describeContract';
import { extractSchemasCommand } from '../src/extractSchemasCommand';
import * as aggregateExtraction from '../src/extractZodSchemas';
import * as projectionExtraction from '../src/extractProjectionSchemas';

afterEach(() => jest.restoreAllMocks());

test('contract description converts valid Zod 4 command, event and state schemas', () => {
  const contract = new Contract()
    .addCommand('accept', z.object({ id: z.string() }))
    .addEvent('accepted', z.object({ id: z.string() }))
    .setStateSchema(z.object({ accepted: z.boolean() }));
  const result = describeContract(contract, 'orders');
  expect(result.aggregate).toBe('orders');
  expect(result.commands.accept).toEqual(z.toJSONSchema(contract.commands.get('accept')!));
  expect(result.events.accepted).toEqual(z.toJSONSchema(contract.events.get('accepted')!));
  expect(result.state).toEqual(z.toJSONSchema(contract.stateSchema!));
});

test.each(['command', 'event', 'state'])('contract %s boundary rejects non-Zod schemas', kind => {
  const contract = new Contract();
  if (kind === 'state') Reflect.set(contract, 'stateSchema', {});
  else Reflect.apply(kind === 'command' ? contract.addCommand : contract.addEvent, contract, ['invalid', {}]);
  expect(() => describeContract(contract)).toThrow('Contract schemas must be Zod 4 schemas.');
});

test.each(['arbitrary', '', true, false])('date handling %j fails before extraction', dateHandling => {
  const aggregate = jest.spyOn(aggregateExtraction, 'extractZodSchemas').mockImplementation(() => {});
  const projection = jest.spyOn(projectionExtraction, 'extractProjectionSchemas').mockImplementation(() => {});
  expect(() => extractSchemasCommand({ entry: 'input.ts', export: 'orders', out: 'output.ts', 'date-handling': dateHandling })).toThrow('--date-handling must be string or date');
  expect(aggregate).not.toHaveBeenCalled();
  expect(projection).not.toHaveBeenCalled();
});

test.each([undefined, 'string', 'date'])('valid date handling %j retains defaults', dateHandling => {
  const aggregate = jest.spyOn(aggregateExtraction, 'extractZodSchemas').mockImplementation(() => {});
  extractSchemasCommand({ entry: 'input.ts', export: 'orders', out: 'output.ts', ...(dateHandling === undefined ? {} : { 'date-handling': dateHandling }) });
  expect(aggregate).toHaveBeenCalledWith(expect.objectContaining({ dateHandling: dateHandling ?? 'string' }));
});
