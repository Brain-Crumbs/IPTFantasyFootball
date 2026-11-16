import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssetCatalog, readContract } from '@brain-crumbs/vibez/assets';
import { loadTaskRegistry, resolveDependencyDag } from '@brain-crumbs/vibez/registry';
import { verifyConsumerAdmission } from './consumer-admission.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const inventory = read('docs/MIG-010-cleanup-manifest.json');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const removed = new Set(inventory.paths.removalCandidates);
const engineDirectories = new Set(getAssetCatalog().contracts.map(({ id }) => id.replace('control-plane.', '')));
const publicModules = new Set([
  'config', 'assets', 'registry', 'lifecycle', 'context', 'validation', 'evidence',
  'review', 'workflow', 'providers', 'integration', 'diagnostics', 'cli',
]);
const packageName = '@brain-crumbs/vibez';

for (const path of tracked) {
  assert.ok(!removed.has(path), 'Do not restore removed Vibez implementation: ' + path);
  assert.ok(!path.startsWith('schemas/v1/'), 'Use the installed Vibez schemas: ' + path);
  assert.ok(!/^(src|contracts)\/[^/]+\//.test(path) || !engineDirectories.has(path.split('/')[1]),
    'Reusable Vibez modules and contracts belong upstream: ' + path);
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
  const source = readFileSync(join(root, path), 'utf8');
  for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)['"\x60]([^'"\x60\s]*@brain-crumbs\/vibez[^'"\x60\s]*)['"\x60]/g)) {
    if (specifier === packageName) continue;
    if (specifier.startsWith(packageName + '/') || specifier.includes('node_modules/')) {
      assert.ok(specifier.startsWith(packageName + '/') && publicModules.has(specifier.slice(packageName.length + 1)),
        'Unsupported Vibez package import in ' + path + ': ' + specifier);
    }
  }
  assert.ok(!/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:\.\.\/)+dist\//.test(source),
    'Embedded build output cannot serve this consumer: ' + path);
}

const config = read('vibez.config.json');
await verifyConsumerAdmission(root);
for (const taskDirectory of [config.paths.tasks, 'migration/tasks']) {
  const registry = await loadTaskRegistry({ repositoryRoot: root, taskDirectory: join(root, taskDirectory) });
  resolveDependencyDag(registry);
  for (const task of registry.values()) {
    for (const id of task.affectedContracts) assert.equal(readContract(id).document.moduleId, id);
  }
}

const receipt = read('migration/admissions/mig-010.json');
const issue = read('migration/sources/issues.json').find(item => item.url === receipt.issue);
const plan = read('migration/plan.json').tasks.find(item => item.taskId === receipt.taskId);
assert.equal(createHash('sha256').update(issue.body).digest('hex'), receipt.issueBodySha256);
assert.equal(issue.updatedAt, receipt.sourceUpdatedAt);
assert.equal(plan.sourceBodySha256, receipt.issueBodySha256);
assert.equal(createHash('sha256').update(readFileSync(join(root, plan.definition))).digest('hex'),
  receipt.definition.sha256, 'Staged and admitted MIG-010 definitions differ');
console.log('Installed Vibez contracts, admission, and source ownership verified.');
