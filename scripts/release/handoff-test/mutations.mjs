import assert from 'node:assert/strict';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadInput } from '../consumer-input.mjs';
import { validateConsumerEvidence } from '../handoff-evidence.mjs';
import { loadEnvelope } from '../handoff-input.mjs';
import { canonicalBytes } from '../release-plan-schema.mjs';
import { hash } from '../workspace.mjs';

export async function mutationMatrix(t, fixture, report, handoff) {
  const aPath = resolve(fixture.a.output, 'manifest.json');
  const policy = await readFile(resolve(fixture.root, 'scripts/release/policy.json'));
  const input = await loadInput(aPath, hash(await readFile(aPath)), resolve(fixture.directory, 'mutation-input'), policy);
  const read = async (path, digest) => {
    const bytes = await readFile(resolve(fixture.directory, 'b', path));
    assert.equal(hash(bytes), digest);
    return bytes;
  };
  const aMutation = async (id, change) => {
    const manifest = structuredClone(input.manifest);
    change(manifest);
    const path = resolve(fixture.a.output, `case-${id}.json`);
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(() => loadInput(path, hash(JSON.stringify(manifest)), resolve(fixture.directory, `snapshot-${id}`), policy));
  };
  await t.test('C4.1 membership/version/held mismatch rejects before Docker', () =>
    aMutation(1, (a) => {
      a.workspaces.find((w) => w.selection === 'candidate').version = '9.0.0';
    })
  );
  await t.test('C4.2 alias/private/unselected-local edge rejects before Docker', () =>
    aMutation(2, (a) => {
      a.edges[0].canonical = '@fixture/private';
    })
  );
  await t.test('C4.3 unreviewed numeric candidate substitution rejects before Docker', () =>
    aMutation(3, (a) => {
      a.edges[0].sourceSpec = '9.0.0';
    })
  );
  await t.test('C4.4 contradictory A never qualifies', () =>
    aMutation(4, (a) => {
      a.exitCode = 1;
    })
  );
  await t.test('C4.5 source/policy binding mismatch rejects before Docker', () =>
    aMutation(5, (a) => {
      a.repository.dirty = !a.repository.dirty;
    })
  );
  const bMutation = async (change) => {
    const b = structuredClone(report);
    change(b);
    await assert.rejects(() => validateConsumerEvidence(b, input, read));
  };
  await t.test('C4.6 green subset B rejected against independently selected roots', () =>
    bMutation((b) => {
      b.selection.roots.pop();
    })
  );
  await t.test('C4.7 missing phase/wrong Node/duplicate root rejected', async () => {
    await bMutation((b) => {
      b.consumers[0].node = '24.20.0';
    });
    await bMutation((b) => {
      delete b.consumers[0].phases.types;
    });
    await bMutation((b) => {
      b.consumers.push(b.consumers[0]);
    });
  });
  await t.test('C4.8 missing readback/resource/cleanup rejected', async () => {
    await bMutation((b) => {
      delete b.staging.receipts[0].downloadedSha256;
    });
    await bMutation((b) => {
      b.resourceOutcomes.pop();
    });
    await bMutation((b) => {
      delete b.cleanup;
    });
  });
  const envelopeMutation = async (id, change, modify = async () => {}) => {
    const directory = resolve(fixture.directory, `bundle-case-${id}`);
    await cp(resolve(fixture.directory, 'handoff'), directory, { recursive: true });
    const envelope = structuredClone(handoff.envelope);
    change(envelope);
    await modify(directory, envelope);
    const bytes = canonicalBytes(envelope);
    await writeFile(resolve(directory, 'envelope.json'), bytes);
    await assert.rejects(() =>
      loadEnvelope(resolve(directory, 'envelope.json'), hash(bytes), resolve(fixture.directory, `admit-case-${id}`), handoff.envelope.toolsSnapshot)
    );
  };
  await t.test('C4.9 changed exact tarball bytes rejected before writes', () =>
    envelopeMutation(
      9,
      () => {},
      async (directory, envelope) => {
        await writeFile(resolve(directory, envelope.artifacts[0].archive), 'wrong bytes');
      }
    )
  );
  await t.test('C4.10 unsafe path/symlink/unknown core rejected', async () => {
    await envelopeMutation('10-path', (e) => {
      e.files[0].path = '../escape';
    });
    await envelopeMutation('10-field', (e) => {
      e.publicMode = true;
    });
    await envelopeMutation(
      '10-link',
      (e) => {
        e.files[0].path = 'linked';
      },
      async (directory) => {
        await symlink(aPath, resolve(directory, 'linked'));
      }
    );
  });
  await t.test('C4.11 wrong channel/implicit tag rejected before writes', () =>
    envelopeMutation(11, (e) => {
      e.destinationTag = 'pre';
    })
  );
  await t.test('C4.15 cross-job source/digest mismatch rejected', async () => {
    await envelopeMutation('15-source', (e) => {
      e.toolsSnapshot = '0'.repeat(64);
    });
    await assert.rejects(() =>
      loadEnvelope(resolve(fixture.directory, 'handoff/envelope.json'), '0'.repeat(64), resolve(fixture.directory, 'wrong-ci'), handoff.envelope.toolsSnapshot)
    );
  });
}
