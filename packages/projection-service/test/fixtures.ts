import { join } from 'node:path';
import { VerifiedArtifact } from '../src/artifact';
import { parseConfig } from '../src/config';

export const artifactDirectory = join(__dirname, '../dist');
export const referenceConfig = parseConfig({ PROJECTION_MODE: 'reference' }, []);
export const externalEnvironment = {
  MONGODB_URI: 'mongodb://user:secret-canary@invalid.example:27017', MONGODB_DATABASE: 'model',
  MONGODB_COMMITS_COLLECTION: 'commits', RABBITMQ_URI: 'amqp://user:secret-canary@invalid.example/%2F',
  RABBITMQ_VHOST: '/', RABBITMQ_EXCHANGE: 'commits', PROJECTION_PARTITION_ID: 'partition',
  RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672', RABBITMQ_MANAGEMENT_USERNAME: 'fixture', RABBITMQ_MANAGEMENT_PASSWORD: 'secret-canary'
};

export function builtArtifact(): Promise<VerifiedArtifact> { return VerifiedArtifact.read(artifactDirectory); }
