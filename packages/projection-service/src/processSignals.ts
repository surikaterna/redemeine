import type { SignalSource } from './shutdown';

/** Process-owned guards prevent native signal termination between host detach and process death. */
export function createProcessSignalSource(source: SignalSource): SignalSource {
  const guarded = new Set<'SIGINT' | 'SIGTERM'>();
  const absorbTerminalSignal = () => {};
  return {
    on(event, listener) {
      if (!guarded.has(event)) {
        source.on(event, absorbTerminalSignal);
        guarded.add(event);
      }
      return source.on(event, listener);
    },
    removeListener(event, listener) { return source.removeListener(event, listener); }
  };
}
