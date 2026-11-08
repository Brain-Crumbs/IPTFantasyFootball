#!/usr/bin/env node
// Read-only MIG-001 registration audit. This is not a task publisher or driver.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTaskRegistry, resolveDependencyDag } from '../dist/task-registry/index.js';

const ROLES = ['Developer', 'QA', 'Architect', 'UAT/Product', 'MergeController'];
const section = (body, name) => body.split(`## ${name}\n\n`)[1].split('\n## ')[0].trim();
export const bodyHash = body => createHash('sha256').update(body, 'utf8').digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export async function validateMigration(root) {
  const plan = await json(resolve(root, 'migration/plan.json'));
  const sources = await json(resolve(root, 'migration/sources/issues.json'));
  assert.equal(plan.formatVersion, 1, 'Unsupported migration plan version');
  assert.equal(plan.sourceEngine.commit, 'fbc46888ce0bd2af454f471561911a913d32e6fc');
  const expected = sources.filter(s => /\*\*Task ID:\*\* (MIG|AUT)-/.test(s.body));
  assert.equal(expected.length, 14, 'All 14 roadmap issues must be captured');
  assert.equal(new Set(sources.map(s => s.url)).size, sources.length, 'Duplicate source issue');
  assert.equal(plan.tasks.length, expected.length, 'Missing or extra task mappings');
  assert.equal(new Set(plan.tasks.map(t => t.taskId)).size, expected.length, 'Duplicate task mapping');
  const registry = await loadTaskRegistry({ repositoryRoot: root, taskDirectory: resolve(root, 'migration/tasks') });
  assert.equal(registry.size, expected.length, 'Missing or extra staged definitions');
  const active = await loadTaskRegistry({ repositoryRoot: root });
  const contracts = new Set();
  // The existing exact-revision contract catalog owns these IDs; no invented contracts.
  for (const task of registry.values()) for (const id of task.affectedContracts) {
    if (!contracts.has(id)) {
      const contract = await json(resolve(root, 'contracts', id.replace('control-plane.', ''), 'module-contract.json'));
      assert.equal(contract.moduleId, id, `Unknown affected contract ${id}`);
      contracts.add(id);
    }
  }
  const graph = new Map();
  const report = [];
  for (const entry of plan.tasks) {
    const source = expected.find(s => s.url === entry.issue);
    assert.ok(source, `Unknown roadmap issue ${entry.issue}`);
    const body = source.body;
    assert.equal(entry.sourceBodySha256, bodyHash(body), `Changed source body for ${entry.taskId}`);
    assert.equal(entry.taskId, body.match(/\*\*Task ID:\*\* (\S+)/)[1]);
    assert.equal(entry.repository, body.match(/\*\*Repository:\*\* (\S+)/)[1]);
    assert.equal(entry.canonicalBranch, body.match(/\*\*Canonical branch:\*\* `([^`]+)`/)[1]);
    assert.equal(entry.integrationTarget, 'main');
    assert.equal(entry.admissionOwner, `Brain-Crumbs maintainer of ${entry.repository} via reviewed admission PR`);
    assert.equal(entry.registration, 'staged', 'This plan grants no runtime admission');
    assert.equal(active.has(entry.taskId), false, `Staged task ${entry.taskId} leaked into the active registry`);
    assert.equal(entry.definition, `migration/tasks/${entry.taskId.toLowerCase()}.task.json`);
    assert.equal(entry.requirement, `requirements/migration/${entry.taskId.toLowerCase()}.requirement.json`);
    const task = registry.get(entry.taskId);
    assert.ok(task, `Missing definition ${entry.taskId}`);
    assert.equal(task.canonicalBranch, entry.canonicalBranch);
    assert.equal(task.title, source.title);
    assert.equal(task.objective, section(body, 'Objective').split('\n\n**Task ID:')[0]);
    assert.deepEqual([...task.inScope], section(body, 'In scope').split('\n').filter(Boolean));
    assert.deepEqual([...task.outOfScope], [section(body, 'Out of scope')]);
    assert.deepEqual([...task.requiredReviewRoles], ROLES);
    const criteria = [...section(body, 'Acceptance criteria').matchAll(/^- \[ \] (.+)$/gm)].map(m => m[1].replaceAll('**', ''));
    assert.deepEqual([...task.acceptanceCriteria], criteria);
    assert.equal(task.validationPlan[0], section(body, 'Validation and evidence'));
    const requirement = await json(resolve(root, entry.requirement));
    assert.equal(requirement.schemaId, 'ipt.requirement');
    assert.equal(requirement.schemaVersion, '1.0.0');
    assert.equal(requirement.taskId, entry.taskId);
    assert.equal(requirement.requirementId, `${entry.taskId}-R1`);
    assert.equal(requirement.statement, task.objective);
    assert.deepEqual(requirement.acceptanceCriteria, criteria);
    assert.deepEqual(requirement.sourceRefs, [entry.issue, `sha256:${entry.sourceBodySha256}`]);
    assert.deepEqual([...task.requirements], [requirement.requirementId]);
    const urls = section(body, 'Dependencies and execution').split('\n\nThis issue')[0]
      .match(/https:\/\/github\.com\/Brain-Crumbs\/[^)\s]+\/issues\/\d+/g) ?? [];
    assert.deepEqual(entry.prerequisites.map(d => d.issue), urls, `Dropped/changed prerequisites for ${entry.taskId}`);
    for (const dep of entry.prerequisites) {
      const upstream = sources.find(s => s.url === dep.issue);
      assert.ok(upstream, `Missing prerequisite source ${dep.issue}`);
      assert.equal(dep.taskId, upstream.body.match(/\*\*Task ID:\*\* (\S+)/)?.[1] ?? 'BOOT-037');
      assert.equal(dep.repository, dep.issue.split('github.com/')[1].split('/issues/')[0]);
      assert.equal(dep.kind, dep.repository === entry.repository ? 'native' : 'external');
      assert.equal(dep.acceptance, null, 'Staged planning cannot assert prerequisite acceptance');
      assert.ok(registry.has(dep.taskId) || (dep.taskId === 'BOOT-037' && dep.issue === 'https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/78'),
        `Missing planned prerequisite ${dep.taskId}`);
    }
    assert.deepEqual([...task.dependencies], entry.prerequisites.filter(d => d.kind === 'native').map(d => d.taskId));
    // Validate the complete cross-repository planning graph without lifecycle state.
    // BOOT-037 is an external acceptance gate, never a synthetic native task.
    graph.set(entry.taskId, { ...task, dependencies: entry.prerequisites.filter(d => registry.has(d.taskId)).map(d => d.taskId) });
    report.push({ taskId: entry.taskId, repository: entry.repository, canonicalBranch: entry.canonicalBranch,
      registration: 'staged', eligible: false, blockers: ['REVIEWED_ADMISSION_REQUIRED', ...entry.prerequisites.map(d => `UNACCEPTED:${d.taskId}`)] });
  }
  resolveDependencyDag(registry);
  resolveDependencyDag(graph);
  return { sourceEngine: plan.sourceEngine, tasks: report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'Usage: node scripts/validate-migration.mjs (read-only; no admission flags)');
    console.log(JSON.stringify(await validateMigration(resolve(dirname(fileURLToPath(import.meta.url)), '..')), null, 2));
  } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}
