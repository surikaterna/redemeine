import { expect, test } from '@jest/globals';
import { joinedMembershipSeedRow, validateJoinedSetInventory, type ApprovedJoinedSetInventory } from '../src/joinedSetCutover';

const inventory: ApprovedJoinedSetInventory = {
  format: 'set-v1', projectionName: 'boards', generation: 'next', linkNamespace: 'example.members',
  documentNamespace: 'example.views', expectedSets: [], maxLinkRows: 5, maxEdges: 4, maxTargetBytes: 2_048
};

test('require explicit known-empty approval even when tombstones are present', () => {
  const tombstone = { aggregateType: 'Order', aggregateId: 'deleted-order', targetDocumentIds: [] };
  expect(() => validateJoinedSetInventory(inventory)).toThrow(/inventory/);
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [tombstone] })).toThrow(/inventory/);
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [tombstone],
    knownEmpty: true, emptyInventoryReference: 'reviewed incident 42' })).not.toThrow();
  expect(joinedMembershipSeedRow(inventory, tombstone)).toMatchObject({ revision: 0, targetDocumentIds: [] });
});

test('group approved edges exactly and bound rows, edges and encoded bytes', () => {
  const members = { aggregateType: 'Order', aggregateId: 'live', targetDocumentIds: ['A', 'B'] };
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [members] })).not.toThrow();
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [members, members] })).toThrow(/Duplicate/);
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [{ ...members, targetDocumentIds: ['B', 'A'] }] }))
    .toThrow(/sorted/);
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [members], maxLinkRows: 0 })).toThrow(/inventory/);
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [members], maxEdges: 1 })).toThrow(/bound/);
  expect(() => validateJoinedSetInventory({ ...inventory, expectedSets: [members], maxTargetBytes: 4 })).toThrow(/bound/);
});
