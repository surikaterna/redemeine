import type { TelemetryAdapter } from './types';

const registeredAdapters = new Map<string, TelemetryAdapter>();

export function registerAdapter(adapter: TelemetryAdapter): void {
  registeredAdapters.set(adapter.id, adapter);
}

export function unregisterAdapter(id: string): boolean {
  return registeredAdapters.delete(id);
}

export function clearAdapters(): void {
  registeredAdapters.clear();
}

export function getAdapter(id: string): TelemetryAdapter | undefined {
  return registeredAdapters.get(id);
}

export function listAdapters(): ReadonlyArray<TelemetryAdapter> {
  return Array.from(registeredAdapters.values());
}
