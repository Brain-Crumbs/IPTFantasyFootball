import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssetCatalog, readContract } from '@brain-crumbs/vibez/assets';
import { loadTaskRegistry, resolveDependencyDag } from '@brain-crumbs/vibez/registry';
import { verifyConsumerAdmission } from './consumer-admission.mjs';
import { verifyMigrationPlan } from './check-migration-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const contents = path => readFileSync(join(root, path), 'utf8');
const read = path => JSON.parse(contents(path));
const inventory = read('docs/MIG-010-cleanup-manifest.json');
const removed = new Set(inventory.paths.removalCandidates);
const removedBlobs = new Set(Object.values(inventory.removedEngineBlobs));
const engineDirectories = new Set([...removed]
  .map(path => path.match(/^(?:src|contracts)\/[^/]+\//)?.[0]).filter(Boolean));
const schemaIds = new Set(getAssetCatalog().schemas.map(({ id }) => id));
const publicModules = new Set([
  'config', 'assets', 'registry', 'lifecycle', 'context', 'validation', 'evidence',
  'review', 'workflow', 'providers', 'integration', 'diagnostics', 'cli',
]);
const packageName = '@brain-crumbs/vibez';
// Allow valid whitespace and comments between an import operator and its literal.
const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const specifiers = new RegExp(
  String.raw`(?:\bfrom${gap}|\bimport${gap}(?:\(${gap})?|\brequire(?:\.resolve)?${gap}\(${gap})['"\x60]([^'"\x60\s]+)['"\x60]`,
  'g',
);

const index = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' });
for (const entry of index.split('\0').filter(Boolean)) {
  const [, blob, path] = /^\d+ ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
  assert.ok(!removed.has(path), 'Do not restore removed Vibez implementation: ' + path);
  assert.ok(!path.startsWith('schemas/v1/'), 'Use the installed Vibez schemas: ' + path);
  assert.ok(!removedBlobs.has(blob), 'Do not relocate a copy of the removed engine or schema: ' + path);
  const directory = path.match(/^(?:src|contracts)\/[^/]+\//)?.[0];
  assert.ok(!engineDirectories.has(directory), 'Reusable Vibez modules and contracts belong upstream: ' + path);
  if (path.endsWith('.json') && contents(path).includes('"$id"')) {
    assert.ok(!schemaIds.has(read(path).$id), 'Use the published schema instead of copying it: ' + path);
  }
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
  for (const [, specifier] of contents(path).matchAll(specifiers)) {
    if (specifier === packageName) continue;
    if (specifier.startsWith(packageName + '/') || specifier.includes('node_modules/' + packageName)) {
      assert.ok(specifier.startsWith(packageName + '/') && publicModules.has(specifier.slice(packageName.length + 1)),
        'Unsupported Vibez package import in ' + path + ': ' + specifier);
    }
    assert.ok(!/^(?:\.\.?\/)+dist\//.test(specifier), 'Embedded build output cannot serve this consumer: ' + path);
  }
}

const config = read('vibez.config.json');
await verifyConsumerAdmission(root);
await verifyMigrationPlan(root);
const registry = await loadTaskRegistry({ repositoryRoot: root, taskDirectory: join(root, config.paths.tasks) });
resolveDependencyDag(registry);
for (const task of registry.values()) {
  for (const id of task.affectedContracts) assert.equal(readContract(id).document.moduleId, id);
}

const receipt = read('migration/admissions/mig-010.json');
const issue = read('migration/sources/issues.json').find(item => item.url === receipt.issue);
const plan = read('migration/plan.json').tasks.find(item => item.taskId === receipt.taskId);
assert.equal(issue.updatedAt, receipt.sourceUpdatedAt);
assert.equal(plan.sourceBodySha256, receipt.issueBodySha256);
assert.equal(createHash('sha256').update(contents(plan.definition)).digest('hex'),
  receipt.definition.sha256, 'Staged and admitted MIG-010 definitions differ');
console.log('Installed Vibez contracts, admission, staged migration plan, and source ownership verified.');
