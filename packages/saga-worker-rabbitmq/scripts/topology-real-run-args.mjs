import { RABBIT_IMAGE } from './topology-runner-core.mjs';
import { OWNER_LABEL } from './topology-runner-ownership.mjs';

export function topologyRabbitRunArgs(names, runId) {
  return ['run', '-d', '--name', names.container, '--label', `${OWNER_LABEL}=${runId}`, '--network', names.network,
    '--mount', `source=${names.volume},target=/var/lib/rabbitmq`,
    '-e', 'RABBITMQ_DEFAULT_USER=topology_owner', '-e', 'RABBITMQ_DEFAULT_PASS=topology_owner_password',
    '-p', '127.0.0.1::5672', '-p', '127.0.0.1::15672', '--user', '100:101', RABBIT_IMAGE];
}
