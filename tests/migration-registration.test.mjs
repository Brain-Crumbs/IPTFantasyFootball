import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateMigration } from '../scripts/validate-migration.mjs';
import { loadTaskRegistry, resolveDependencyDag, selectNextEligibleTask } from '../dist/task-registry/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'migration registration '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['migration', 'requirements', 'schemas/v1', 'tasks/definitions', 'contracts']) {
    await cp(new URL(`../${path}`, import.meta.url), join(root, path), { recursive: true });
  }
  return root;
}
async function edit(root, path, change) {
  const full = join(root, path), value = JSON.parse(await readFile(full, 'utf8'));
  change(value);
  await writeFile(full, JSON.stringify(value));
}
async function hashes(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(root, path));
    else result[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  }
  return result;
}
test('all 14 issue mappings validate; default registry and historical canary stay unchanged', async t => {
  const root = await fixture(t), before = await hashes(root);
  const report = await validateMigration(root);
  assert.equal(report.tasks.length, 14);
  assert.ok(report.tasks.every(t => !t.eligible && t.registration === 'staged'));
  assert.ok(report.tasks.find(t => t.taskId === 'MIG-006').blockers.includes('UNACCEPTED:BOOT-037'));
  assert.ok(report.tasks.find(t => t.taskId === 'AUT-004').blockers.includes('UNACCEPTED:MIG-010'));
  const active = await loadTaskRegistry({ repositoryRoot: root });
  assert.deepEqual([...active.keys()], ['CANARY-001']);
  assert.equal(selectNextEligibleTask(active).taskId, 'CANARY-001');
  assert.deepEqual(await hashes(root), before, 'Audit must not write any source, runtime or evidence file');
});
for (const [name, path, mutate, message] of [
  ['invalid task', 'migration/tasks/mig-004.task.json', t => { t.schemaVersion = '99.0.0'; }, /version|schema/i],
  ['dropped cross-repository prerequisite', 'migration/plan.json', p => { p.tasks.find(t => t.taskId === 'MIG-002').prerequisites = []; }, /prerequisites/],
  ['invented external acceptance', 'migration/plan.json', p => { p.tasks.find(t => t.taskId === 'MIG-002').prerequisites[0].acceptance = { state: 'DONE' }; }, /cannot assert/],
  ['wrong canonical branch', 'migration/tasks/mig-002.task.json', t => { t.canonicalBranch = 'personal/other'; }, /Expected values/],
  ['changed source issue', 'migration/sources/issues.json', s => { s[0].body += '\nChanged'; }, /Changed source body/],
  ['missing requirement traceability', 'requirements/migration/mig-001.requirement.json', r => { r.sourceRefs = []; }, /Expected values/],
]) test(`${name} fails without publishing or changing state`, async t => {
  const root = await fixture(t);
  await edit(root, path, mutate);
  const before = await hashes(root);
  await assert.rejects(validateMigration(root), message);
  assert.deepEqual(await hashes(root), before);
});
test('unresolved staged task cannot be put in the active registry by copying it', async t => {
  const root = await fixture(t);
  await cp(join(root, 'migration/tasks/mig-002.task.json'), join(root, 'tasks/definitions/mig-002.task.json'));
  const before = await hashes(root);
  await assert.rejects(validateMigration(root), /leaked into the active registry/);
  assert.deepEqual(await hashes(root), before);
});
test('native DAG tooling rejects missing and cyclic dependencies; staged records are not completion facts', async t => {
  const root = await fixture(t);
  const registry = await loadTaskRegistry({ repositoryRoot: root, taskDirectory: join(root, 'migration/tasks') });
  const task = registry.get('MIG-004');
  const missing = new Map(registry).set('MIG-004', { ...task, dependencies: ['MISSING-001'] });
  assert.throws(() => resolveDependencyDag(missing), /dependency|missing/i);
  const cycle = new Map(registry).set('MIG-003', { ...registry.get('MIG-003'), dependencies: ['MIG-004'] });
  assert.throws(() => resolveDependencyDag(cycle), /cycle/i);
  // Raw staged definitions omit external edges by design and MUST NOT be a runtime registry.
  assert.equal(registry.get('MIG-002').dependencies.length, 0);
  assert.equal((await validateMigration(root)).tasks.find(t => t.taskId === 'MIG-002').eligible, false);
});
