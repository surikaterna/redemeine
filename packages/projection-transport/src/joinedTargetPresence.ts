// Match on the server and return only the identity. JSON null is a stored state, not an absent field.
export const joinedTargetPresence = { state: { $exists: true }, $expr: { $and: [
  { $ne: [{ $ifNull: ['$deleted', false] }, true] },
  { $ne: [{ $ifNull: ['$tombstone', false] }, true] }
] } } as const;
export const joinedTargetIdentityProjection = { _id: 1 } as const;
