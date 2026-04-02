# Testing Aggregates: The BDD Recipe

> Contract reference: see [Testing DX v1 Contracts](/docs/architecture/testing-dx-v1-contracts) for locked fixture API and semantics under bead `redemeine-t8g.1`.

One of the greatest benefits of using Redemeine's pure CQRS and Event Sourcing architecture is testing. Because your domain logic is completely decoupled from infrastructure (no databases, no external API calls, no complex mock setups), you can test your core business rules instantly in memory.

The best way to test Event Sourced systems is using the **Given / When / Then** (Behavior-Driven Development) pattern:

- **Given:** An initial state, built by applying past historical events.
- **When:** A specific command is dispatched.
- **Then:** We assert the correct new events were emitted, or that the correct domain error was thrown.

---

## The Shipment Example

Let's imagine a `Shipment` aggregate that tracks delivery status. You can only dispatch a shipment once.

Here is a complete, copy-pasteable test suite demonstrating how effortless testing becomes with Redemeine, using standard Jest or Vitest syntax.

```ts
import { describe, it, expect } from 'vitest'; // or from '@jest/globals'
import { createMirage, extractUncommittedEvents, clearUncommittedEvents } from '@redemeine/mirage';

// 1. Import your built aggregate blueprint from your domain folder
import { ShipmentAggregate } from './ShipmentAggregate';

describe('Shipment Aggregate', () => {

  it('Given a new shipment, When dispatching, Then it should emit a dispatched event', () => {
    
    // GIVEN: We instantiate a fresh live aggregate in memory 
    const shipmentId = 'ship-123';
    const shipment = createMirage(ShipmentAggregate, shipmentId);

    // WHEN: We trigger the dispatch command
    shipment.dispatchToCarrier({ carrierName: 'FedEx' });

    // THEN: We extract the events emitted during this session to verify behavior
    const uncommittedEvents = extractUncommittedEvents(shipment);

    // We expect exactly one event to have been recorded
    expect(uncommittedEvents).toHaveLength(1);
    
    // We assert the type and the payload of the event match our business logic
    expect(uncommittedEvents[0]).toMatchObject({
      type: 'shipment.dispatched.event',
      payload: { carrierName: 'FedEx' }
    });

    // We can also verify the internal state updated correctly!
    expect(shipment.status).toBe('in-transit');
  });


  it('Given a dispatched shipment, When dispatching again, Then it throws an invariant error', () => {
    
    // GIVEN: We start with a shipment that has ALREADY been dispatched.
    // We recreate history by applying events during setup.
    const shipment = createMirage(ShipmentAggregate, 'ship-123');
    
    // Simulate past history by running the required commands to get into the desired state. 
    // (Alternatively, you can seed `createMirage` with an initial pre-hydrated state object directly!)
    shipment.dispatchToCarrier({ carrierName: 'FedEx' });

    // Clear the event queue so we only test what happens NEXT
    clearUncommittedEvents(shipment);

    // WHEN / THEN: We attempt to dispatch again and assert it fails
    expect(
      () => shipment.dispatchToCarrier({ carrierName: 'UPS' })
    ).toThrow('Shipment has already been dispatched. Cannot dispatch twice.');
    
    // Verify no erroneous events leaked into the system
    expect(extractUncommittedEvents(shipment)).toHaveLength(0);
  });

});
```

### Why is this DX so good?

1. **Zero Mocks:** Notice there are no `jest.mock('database')` or `spyOn(api)` calls. 
2. **Speed:** These tests run in milliseconds because they are entirely CPU-bound data transformations.
3. **Type-Safety:** Standard IDE autocomplete will guide you while writing your `.dispatchToCarrier()` arguments during test creation, ensuring your tests never drift from your actual Command typings.
