const lines = new Map([
  ['Dispatcher started; externally fenced single owner required', 'started_not_cursor_ready'],
  ['Dispatcher fatal: Rabbit connection/setup failed', 'fatal_rabbit_setup'],
  ['Rabbit connection/setup failed', 'fatal_rabbit_setup'],
  ['Dispatcher retry: Mandatory publication unroutable', 'mandatory_publication_unroutable'],
  ['Dispatcher fatal: Checkpoint feed mismatch or unidentifiable legacy state; explicit migration required', 'fatal_checkpoint_feed'],
  ['Dispatcher fatal: Custom checkpoint store must durably roundtrip all versioned recovery fields and BSON values', 'fatal_checkpoint_roundtrip'],
  ['Missing --mongodb-uri', 'missing_mongodb_uri'], ['Missing --rabbitmq-uri', 'missing_rabbitmq_uri'],
  ['Missing --database', 'missing_database'], ['Missing --collection', 'missing_collection'], ['Missing --exchange', 'missing_exchange']
]);

export function publisherLogFacts(raw: string): string[] {
  const output = new Set<string>();
  for (const line of raw.split('\n').slice(0, 200)) {
    const kind = lines.get(line.trim()); if (kind) output.add(kind);
  }
  return [...output];
}
