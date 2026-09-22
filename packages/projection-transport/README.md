# Projection transport

Private nonsharded transport adapters for commit-native projections.

- Tapeworm is pinned to `0.6.0`. The range reader requires an indexed
  `readCommitRangeByCommitSequence` capability that guarantees complete commit boundaries. It
  deliberately does not fall back to `queryStream(fromEventSequence)`, because Tapeworm may slice
  the first commit, or to `queryAll`/a full-stream scan.
- Rabbit uses manual settlement. Completion means every registry definition and durable transport
  coverage completed before the one ACK attempt. Retry requires a durable publisher receipt whose
  not-before time satisfies the configured backoff; the worker never sleeps while holding a
  delivery. Permanent failures are rejected without requeue to the configured DLX.
- Mongo transport coverage is only contiguous ordering metadata. It does not suppress projection
  dispatch, including `none` definitions. Coverage and immutable start anchors are keyed by queue
  binding and canonical source UUID, use compare-and-advance, and have no TTL.
- The complete registry manifest is immutable for a queue. Definition, runtime configuration, code
  digests, source selectors, and start anchors are checked on every startup/reconnect. A reduced or
  changed registry fails before consumption; old bindings are never overwritten.

This package does not implement shard queues, fanout, an inbox, a saga, or distributed ownership.
