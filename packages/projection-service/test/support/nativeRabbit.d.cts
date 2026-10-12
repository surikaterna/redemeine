import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

export interface NativeRabbitFixture {
  readonly model: ChannelModel;
  readonly channels: Channel[];
  readonly frames: Array<{ number: number; method: string }>;
  readonly version: string;
  closeConnection(): void;
  closeChannel(): void;
  deliver(message: ConsumeMessage): void;
  state(): { channelClosed: boolean; connectionClosed: boolean; network: false };
}

export function createNativeRabbit(options?: {
  localPort?: number;
  suspendClose?: boolean;
  onDeclare?: (args: Record<string, unknown>) => void;
  onBind?: () => void;
  onConsume?: (tag: string, channel: number) => void;
  onClose?: () => void;
}): NativeRabbitFixture;
