export type TelemetryPrimitive = string | number | boolean;

export type TelemetryAttributeValue =
  | TelemetryPrimitive
  | null
  | undefined
  | ReadonlyArray<TelemetryPrimitive>;

export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

export interface TelemetryCarrier {
  readonly [key: string]: string | undefined;
}

export type MutableTelemetryCarrier = Record<string, string>;

export interface TelemetryContext {
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface TelemetryAdapter {
  readonly id: string;
  extract?(carrier: TelemetryCarrier): TelemetryContext | null;
  inject?(context: TelemetryContext, carrier: MutableTelemetryCarrier): void;
}
