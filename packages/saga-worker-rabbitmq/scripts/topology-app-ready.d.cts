export type ProbeCommand = 'ping' | 'check_running';
export interface ProbeOutcome { readonly code: number | null; readonly status: string }
export interface AppReadyOptions {
  readonly probe: (command: ProbeCommand, timeoutMs: number) => Promise<ProbeOutcome>;
  readonly isExited: () => Promise<boolean>;
  readonly interrupted?: () => boolean;
  readonly onAttempt?: () => void;
  readonly onProbe?: (command: ProbeCommand, result: ProbeOutcome) => void;
  readonly deadlineMs?: number;
  readonly probeMs?: number;
  readonly delayMs?: number;
}
export function waitForRabbitApp(options: AppReadyOptions): Promise<void>;
