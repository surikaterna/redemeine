import type { Channel, ConfirmChannel, Message } from 'amqplib';

export interface ConfirmedCommit {
  readonly id: string;
  readonly partitionId: string;
  readonly collection: string;
  readonly tenant?: string;
}

/** Publisher confirms do not imply routing: basic.return must be checked separately. */
export async function publishConfirmedCommit(channel: ConfirmChannel, exchange: string, commit: ConfirmedCommit, expectReturn: boolean): Promise<void> {
  const streamId = `stream-${commit.id}`;
  const body = { id: commit.id, partitionId: commit.partitionId, streamId, commitSequence: 0,
    createDateTime: new Date().toISOString(), events: [{ id: `event-${commit.id}`, type: 'Created', version: 0, payload: { id: commit.id } }] };
  const returned: Message[] = [];
  const onReturn = (message: Message) => { returned.push(message); };
  channel.on('return', onReturn);
  try {
    const confirmed = new Promise<void>((resolve, reject) => {
      channel.publish(exchange, '', Buffer.from(JSON.stringify(body)), {
        contentType: 'application/json', deliveryMode: 2, mandatory: true, messageId: commit.id,
        headers: { collection: commit.collection, partitionId: commit.partitionId, streamId,
          ...(commit.tenant === undefined ? {} : { tenant: commit.tenant }) }
      }, (error) => { if (error) reject(error); else resolve(); });
    });
    await confirmed;
    await channel.waitForConfirms();
    if (returned.length !== Number(expectReturn) || (expectReturn && returned[0]?.properties.messageId !== commit.id)) {
      throw new Error(`mandatory publish routing mismatch for ${commit.id}: returned ${returned.length} messages`);
    }
  } finally {
    channel.off('return', onReturn);
  }
}

function brokerCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'number') return error.code;
  if ('cause' in error) return brokerCode(error.cause);
  return undefined;
}

export async function expectBrokerRejection(channel: Pick<Channel, 'on' | 'off'>, operation: () => Promise<void>, expectedCode: number): Promise<void> {
  const emitted: unknown[] = [];
  const onError = (error: unknown) => { emitted.push(error); };
  channel.on('error', onError);
  try {
    let rejected: unknown;
    try {
      await operation();
    } catch (error) {
      rejected = error;
    }
    if (brokerCode(rejected) !== expectedCode || emitted.length !== 1 || brokerCode(emitted[0]) !== expectedCode) {
      throw Object.assign(new Error('broker reply mismatch'), {
        expectedCode, actualCode: brokerCode(rejected) ?? null, replyCode: brokerCode(emitted[0]) ?? null
      });
    }
  } finally {
    channel.off('error', onError);
  }
}
