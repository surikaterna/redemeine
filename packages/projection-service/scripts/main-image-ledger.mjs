import assert from 'node:assert/strict';

export function ownedResource(plan, row, entry) {
  assert.ok(row && row.Config && row.Config.Labels, 'resource_inspection_invalid');
  for (const [key, value] of Object.entries(plan.labels)) assert.equal(row.Config.Labels[key], value, 'foreign_resource_refused');
  assert.match(row.Id, /^(sha256:)?[a-f0-9]{64}$/);
  if (entry.type === 'container') assert.equal(row.Name, `/${entry.name}`, 'resource_name_replaced');
  else assert.ok(row.RepoTags?.includes(entry.name), 'resource_tag_replaced');
  if (entry.id) assert.equal(row.Id, entry.id, 'resource_id_replaced');
  return row.Id;
}

/** Only three declared resources; intent is recorded before a daemon-affecting command. */
export class ImageResourceLedger {
  constructor(plan) {
    assert.equal(plan.containers.length, 2);
    this.entries = [{ type: 'image', name: plan.image }, ...plan.containers.map((row) => ({ type: 'container', name: row.name }))]
      .map((row) => ({ ...row, attempted: false, id: null, daemonUncertain: false, nativeNoSpawn: false }));
    assert.equal(new Set(this.entries.map((row) => row.name)).size, 3);
    this.plan = plan; this.ready = false;
  }

  async preflight(inspect) {
    for (const entry of this.entries) assert.equal(await inspect(entry.type, entry.name), null, 'preexisting_resource_refused');
    this.ready = true;
  }

  intent(type, name) {
    assert.ok(this.ready, 'preflight_not_proven');
    const entry = this.entries.find((row) => row.type === type && row.name === name);
    assert.ok(entry && !entry.attempted, 'resource_intent_refused'); entry.attempted = true; return entry;
  }

  identify(entry, row) {
    assert.ok(entry.attempted && !entry.nativeNoSpawn, 'resource_not_attempted');
    const id = ownedResource(this.plan, row, entry); entry.id = id; return id;
  }

  failed(entry, result) {
    entry.nativeNoSpawn = result?.nativeNoSpawn === true;
    entry.daemonUncertain = !entry.nativeNoSpawn;
  }

  async cleanup(inspect, remove, record, uncertain, checkDeadline) {
    const entries = [...this.entries.filter((row) => row.type === 'container'), this.entries[0]];
    for (const entry of entries) {
      if (!entry.attempted || entry.nativeNoSpawn) continue;
      if (entry.daemonUncertain) uncertain({ resource: entry.name, reason: 'daemon_completion_unproven' });
      try {
        checkDeadline(); const row = await inspect(entry.type, entry.name);
        if (!row) { record({ resource: entry.name, absent: true, daemonCompletionProven: !entry.daemonUncertain }); continue; }
        const id = this.identify(entry, row);
        await remove(entry, id);
        const after = await inspect(entry.type, entry.name);
        if (after) { ownedResource(this.plan, after, entry); throw new Error('resource_removal_not_observed'); }
        record({ resource: entry.name, id, removed: true, daemonCompletionProven: !entry.daemonUncertain });
      } catch { uncertain({ resource: entry.name, reason: 'cleanup_not_proven' }); }
    }
  }
}
