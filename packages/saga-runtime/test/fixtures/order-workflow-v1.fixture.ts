declare const require: (id: string) => any;

const sagaPackage = require('@redemeine/saga');

const {
  createSaga,
  defineOneWay,
  defineRequestResponse,
  defineSagaPlugin
} = sagaPackage as {
  createSaga: <TState = unknown>(options: Record<string, unknown>) => any;
  defineOneWay: <TBuild extends (...args: any[]) => unknown>(build: TBuild) => unknown;
  defineRequestResponse: <TBuild extends (...args: any[]) => unknown>(build: TBuild) => unknown;
  defineSagaPlugin: (manifest: Record<string, unknown>) => unknown;
};

export interface OrderWorkflowState {
  progression: string[];
  lastOrderId: string;
}

export interface OrderWorkflowScenario {
  name: string;
  sagaId: string;
  expectedProgression: string[];
  events: Array<{
    type: string;
    payload: Record<string, unknown>;
    expectedIntentTypes: string[];
  }>;
}

export const PaymentsPlugin = defineSagaPlugin({
  plugin_key: 'payments',
  actions: {
    authorize: defineRequestResponse((payload: { orderId: string; amount: number }) => payload)
  }
});

export const InventoryPlugin = defineSagaPlugin({
  plugin_key: 'inventory',
  actions: {
    reserve: defineRequestResponse((payload: { orderId: string; sku: string; quantity: number }) => payload)
  }
});

export const ShippingPlugin = defineSagaPlugin({
  plugin_key: 'shipping',
  actions: {
    dispatch: defineOneWay((payload: { orderId: string; carrier: string }) => payload)
  }
});

export const NotificationPlugin = defineSagaPlugin({
  plugin_key: 'notifications',
  actions: {
    send: defineOneWay((payload: { orderId: string; template: string }) => payload)
  }
});

export const createOrderWorkflowSaga = () => createSaga<OrderWorkflowState>({
  identity: {
    namespace: 'runtime',
    name: 'order_workflow_v1',
    version: 1
  },
  plugins: [PaymentsPlugin, InventoryPlugin, ShippingPlugin, NotificationPlugin] as const
})
  .initialState(() => ({ progression: [], lastOrderId: '' }))
  .onResponses({
    'payments.authorize.ok': () => undefined,
    'inventory.reserve.ok': () => undefined
  })
  .onErrors({
    'payments.authorize.failed': () => undefined,
    'inventory.reserve.failed': () => undefined
  })
  .on({ __aggregateType: 'orders', pure: { eventProjectors: {} }, commandCreators: {} } as const, {
    placed: (state: OrderWorkflowState, event: { payload: { orderId: string; amount: number; sku: string; quantity: number } }, ctx: any) => {
      ctx.actions.inventory
        .reserve({
          orderId: event.payload.orderId,
          sku: event.payload.sku,
          quantity: event.payload.quantity
        })
        .onResponse(ctx.onResponse['inventory.reserve.ok'])
        .onError(ctx.onError['inventory.reserve.failed']);

      ctx.actions.payments
        .authorize({ orderId: event.payload.orderId, amount: event.payload.amount })
        .onResponse(ctx.onResponse['payments.authorize.ok'])
        .onError(ctx.onError['payments.authorize.failed']);

      state.progression.push('placed');
      state.lastOrderId = event.payload.orderId;
    },
    authorized: (state: OrderWorkflowState, event: { payload: { orderId: string } }, ctx: any) => {
      ctx.actions.core.runActivity('order.audit.prepare', () => ({
        orderId: event.payload.orderId,
        stage: 'authorized'
      }));

      ctx.actions.shipping.dispatch({
        orderId: event.payload.orderId,
        carrier: 'dhl'
      });

      state.progression.push('authorized');
      state.lastOrderId = event.payload.orderId;
    },
    packed: (state: OrderWorkflowState, event: { payload: { orderId: string } }, ctx: any) => {
      ctx.actions.core.schedule('delivery-followup', 60_000);
      ctx.actions.notifications.send({ orderId: event.payload.orderId, template: 'packed' });

      state.progression.push('packed');
      state.lastOrderId = event.payload.orderId;
    },
    dispatched: (state: OrderWorkflowState, event: { payload: { orderId: string } }, ctx: any) => {
      ctx.actions.notifications.send({ orderId: event.payload.orderId, template: 'dispatched' });

      state.progression.push('dispatched');
      state.lastOrderId = event.payload.orderId;
    },
    delivered: (state: OrderWorkflowState, event: { payload: { orderId: string } }, ctx: any) => {
      ctx.actions.core.cancelSchedule('delivery-followup');
      ctx.actions.notifications.send({ orderId: event.payload.orderId, template: 'delivered' });

      state.progression.push('delivered');
      state.lastOrderId = event.payload.orderId;
    },
    settled: (state: OrderWorkflowState, event: { payload: { orderId: string } }, ctx: any) => {
      ctx.actions.core.runActivity('order.audit.finalize', () => ({
        orderId: event.payload.orderId,
        stage: 'settled'
      }));

      state.progression.push('settled');
      state.lastOrderId = event.payload.orderId;
    },
    closed: (state: OrderWorkflowState, event: { payload: { orderId: string } }, ctx: any) => {
      ctx.actions.notifications.send({ orderId: event.payload.orderId, template: 'closed' });

      state.progression.push('closed');
      state.lastOrderId = event.payload.orderId;
    }
  })
  .build();

export const orderWorkflowScenarios: readonly OrderWorkflowScenario[] = [
  {
    name: 'minimal 2-step checkout to authorization',
    sagaId: 'order-workflow-2-step',
    expectedProgression: ['placed', 'authorized'],
    events: [
      {
        type: 'orders.placed.event',
        payload: { orderId: 'order-2', amount: 4900, sku: 'sku-2', quantity: 1 },
        expectedIntentTypes: ['plugin-request', 'plugin-request']
      },
      {
        type: 'orders.authorized.event',
        payload: { orderId: 'order-2' },
        expectedIntentTypes: ['run-activity', 'plugin-one-way']
      }
    ]
  },
  {
    name: 'mid-path 4-step fulfillment',
    sagaId: 'order-workflow-4-step',
    expectedProgression: ['placed', 'authorized', 'packed', 'dispatched'],
    events: [
      {
        type: 'orders.placed.event',
        payload: { orderId: 'order-4', amount: 8900, sku: 'sku-4', quantity: 2 },
        expectedIntentTypes: ['plugin-request', 'plugin-request']
      },
      {
        type: 'orders.authorized.event',
        payload: { orderId: 'order-4' },
        expectedIntentTypes: ['run-activity', 'plugin-one-way']
      },
      {
        type: 'orders.packed.event',
        payload: { orderId: 'order-4' },
        expectedIntentTypes: ['schedule', 'plugin-one-way']
      },
      {
        type: 'orders.dispatched.event',
        payload: { orderId: 'order-4' },
        expectedIntentTypes: ['plugin-one-way']
      }
    ]
  },
  {
    name: 'extended 7-step order-to-close workflow',
    sagaId: 'order-workflow-7-step',
    expectedProgression: ['placed', 'authorized', 'packed', 'dispatched', 'delivered', 'settled', 'closed'],
    events: [
      {
        type: 'orders.placed.event',
        payload: { orderId: 'order-7', amount: 12900, sku: 'sku-7', quantity: 3 },
        expectedIntentTypes: ['plugin-request', 'plugin-request']
      },
      {
        type: 'orders.authorized.event',
        payload: { orderId: 'order-7' },
        expectedIntentTypes: ['run-activity', 'plugin-one-way']
      },
      {
        type: 'orders.packed.event',
        payload: { orderId: 'order-7' },
        expectedIntentTypes: ['schedule', 'plugin-one-way']
      },
      {
        type: 'orders.dispatched.event',
        payload: { orderId: 'order-7' },
        expectedIntentTypes: ['plugin-one-way']
      },
      {
        type: 'orders.delivered.event',
        payload: { orderId: 'order-7' },
        expectedIntentTypes: ['cancel-schedule', 'plugin-one-way']
      },
      {
        type: 'orders.settled.event',
        payload: { orderId: 'order-7' },
        expectedIntentTypes: ['run-activity']
      },
      {
        type: 'orders.closed.event',
        payload: { orderId: 'order-7' },
        expectedIntentTypes: ['plugin-one-way']
      }
    ]
  }
];
