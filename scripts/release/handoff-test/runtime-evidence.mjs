import assert from 'node:assert/strict';
import { containedRead } from '../consumer-files.mjs';
import { validateConsumerEvidence } from '../handoff-evidence.mjs';
import { hash } from '../workspace.mjs';

export async function runtimeEvidenceCases(t, admitted) {
  const { report, input } = admitted;
  const read = async (path, expected) => {
    const bytes = await containedRead(admitted.root, `b/${path}`, 32 * 1024 * 1024);
    assert.equal(hash(bytes), expected);
    return bytes;
  };
  await validateConsumerEvidence(report, input, read);
  const results = [];
  for (const [index, consumer] of report.consumers.entries()) {
    const donor = report.consumers.find((item) => item.node === consumer.node && item.root[0] !== consumer.root[0]);
    assert(donor, 'The genuine baseline must cover two distinct roots on the same Node');
    for (const [family, mutate] of mutations(donor)) {
      await t.test(`F1 ${family}: ${consumer.root[0]} Node${consumer.node}`, async () => {
        results.push(await rejectMutation(report, input, read, index, family, mutate));
      });
    }
  }
  await validateConsumerEvidence(report, input, read);
  return { inputSha256: input.digest, positiveConsumers: report.consumers.length, results };
}

function runtimeIndices(consumer) {
  return consumer.commands.flatMap((item, index) => (item.program === 'node' && item.args.includes('-e') ? [index] : []));
}

function mutations(donor) {
  return [
    [
      'wrong-root replay',
      (consumer, indices) => {
        consumer.commands[indices[0]] = structuredClone(donor.commands[runtimeIndices(donor)[0]]);
      }
    ],
    [
      'duplicate replaces required surface/mode',
      (consumer, indices) => {
        assert(indices.length >= 2);
        consumer.commands[indices.length > 2 ? indices[2] : indices[1]] = structuredClone(consumer.commands[indices[0]]);
      }
    ],
    [
      'no-op mentioning the claimed root',
      (consumer, indices) => {
        consumer.commands[indices[0]].args[consumer.commands[indices[0]].args.length - 1] = `// ${JSON.stringify(consumer.root[0])}\nvoid 0;`;
      }
    ],
    [
      'runtime before install prerequisite',
      (consumer, indices) => {
        [consumer.commands[1], consumer.commands[indices[0]]] = [consumer.commands[indices[0]], consumer.commands[1]];
      }
    ]
  ];
}

async function rejectMutation(original, input, read, index, family, mutate) {
  const report = structuredClone(original);
  const consumer = report.consumers[index];
  mutate(consumer, runtimeIndices(consumer));
  const { identity: omitted, receiptSha256: previous, ...raw } = consumer;
  const bytes = Buffer.from(JSON.stringify(raw, null, 2));
  consumer.receiptSha256 = hash(bytes);
  let reboundRead = false;
  const rebound = async (path, expected) => {
    if (path !== `consumer-${index}.json`) return read(path, expected);
    assert.equal(hash(bytes), expected);
    reboundRead = true;
    return bytes;
  };
  await assert.rejects(
    () => validateConsumerEvidence(report, input, rebound),
    (error) => error.code === 2 && /B runtime command binding/.test(error.message)
  );
  assert(reboundRead, 'Rejection must occur after the hash-consistent raw receipt was admitted');
  return { family, root: consumer.root[0], node: consumer.node, rawSha256: consumer.receiptSha256, exitCode: 2, reboundRead, resourcesStarted: 0 };
}
