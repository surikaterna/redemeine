// ---------------------------------------------------------------------------
// Connection state — types for monitoring upstream connectivity
// ---------------------------------------------------------------------------

/** Connection state of the link to the upstream node. */
export type ConnectionState = 'online' | 'offline' | 'reconnecting';

/** Callback invoked when the connection state changes. */
export type ConnectionStateListener = (state: ConnectionState) => void;

/** Disposes a subscription, removing the listener. */
export type Unsubscribe = () => void;

/**
 * Adapter contract for monitoring the connection to the upstream node.
 *
 * Implementations are transport-specific — e.g. WebSocket heartbeat,
 * HTTP ping, or scomp channel state.
 */
export interface IConnectionMonitor {
  /** Returns the current connection state. */
  getState(): ConnectionState;

  /**
   * Subscribes to connection state changes.
   *
   * @param listener — called whenever the state transitions.
   * @returns a function that removes the listener when called.
   */
  onStateChange(listener: ConnectionStateListener): Unsubscribe;
}
