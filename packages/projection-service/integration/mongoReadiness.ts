import { budgets } from './plan';
import { record, waitUntil } from './schema';

export type MongoScriptExecutor = (script: string) => Promise<string>;
export const replicationOptionsScript = 'print(JSON.stringify(db.adminCommand({getCmdLineOpts:1}).parsed.replication));';
export const initializeReplicaScript = 'const result=rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]});if(!result.ok)quit(1);';
export const primaryReadinessScript = 'print(JSON.stringify(db.hello()));';

export function replicationOptionsReady(stdout: string): boolean {
  try {
    const value: unknown = JSON.parse(stdout); const options = record(value);
    return options.replSet === 'rs0' && options.oplogSizeMB === 64;
  } catch { return false; }
}

export async function initializeMongoReplica(exec: MongoScriptExecutor, signal: AbortSignal): Promise<void> {
  await waitUntil(async () => {
    try { return replicationOptionsReady(await exec(replicationOptionsScript)); }
    catch { return false; }
  }, budgets.scenarioMs, signal);
  await exec(initializeReplicaScript);
  await waitUntil(async () => {
    try { const value: unknown = JSON.parse(await exec(primaryReadinessScript)); return record(value).isWritablePrimary === true; }
    catch { return false; }
  }, budgets.scenarioMs, signal);
}
