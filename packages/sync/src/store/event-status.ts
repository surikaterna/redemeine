/**
 * Discriminated union representing the lifecycle state of a stored event.
 *
 * - `pending`     — event produced optimistically by a downstream node;
 *                   awaiting authoritative confirmation from upstream.
 * - `confirmed`   — event confirmed as authoritative (either directly
 *                   from upstream, or a pending event whose upstream
 *                   match arrived).
 * - `superseded`  — a pending event that was replaced by a divergent
 *                   authoritative event from upstream. Superseded events
 *                   are retained for audit trail purposes.
 */
export type EventStatus = 'pending' | 'confirmed' | 'superseded';
