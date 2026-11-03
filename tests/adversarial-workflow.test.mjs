import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { FileAssignmentLockStore } from '../dist/assignment-lock/index.js';
import { createLocalArchitectureReviewGate } from '../dist/architecture-review/index.js';
import { createLocalControlledMergeController } from '../dist/controlled-merge/index.js';
import { createLocalDeveloperStartWorkflow } from '../dist/dev-start/index.js';
import { createLocalDeveloperValidationGate } from '../dist/dev-validation/index.js';
import { FileEvidenceStore, reviewResultLineageId, validationEvidenceLineageId } from '../dist/evidence-store/index.js';
import { createLocalQaReviewGate } from '../dist/qa-review/index.js';
import { ReviewFramework } from '../dist/review-framework/index.js';
import { DependencyDagValidationError } from '../dist/task-registry/index.js';
import { createLocalUatReviewGate } from '../dist/uat-review/index.js';
import { ensureCanaryPullRequest, runCanary } from '../scripts/canary.mjs';
import { authoritativeFiles, canonicalBranch, createCanaryFixture, git, marker, readLifecycle, sourceRoot, taskId } from './helpers/canary-fixture.mjs';

// Fixture judgments are test inputs, never independent live role approvals.
// See docs/ADVERSARIAL_TESTS.md for the issue/master-invariant mapping.
function fixture(t, options = {}) {
  const f = createCanaryFixture(options);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}
function put(root, relative, content) {
  mkdirSync(join(root, relative, '..'), { recursive: true });
  writeFileSync(join(root, relative), content);
}
function definition(f) {
  return JSON.parse(readFileSync(join(f.root, 'tasks/definitions/canary-001.task.json'), 'utf8'));
}
function setDefinition(f, task) {
  put(f.root, 'tasks/definitions/canary-001.task.json', `${JSON.stringify(task, null, 2)}\n`);
}
function evidence(f) {
  return new FileEvidenceStore(join(f.root, '.agent/state/evidence'), { repositoryRoot: f.root });
}
function mutationCalls(f) {
  return f.remote.calls.filter(call => call.method !== 'GET');
}
function mergeRequest() {
  return { taskId, actorId: 'adversarial-merge-controller', runId: 'adversarial-merge', occurredAt: new Date().toISOString() };
}
function assertNoCompletion(f) {
  const history = readLifecycle(f.root)?.history ?? [];
  assert.ok(history.every(event => !['MERGED', 'DONE'].includes(event.toState)));
  assert.equal(git(f.root, 'rev-parse', 'main'), f.initialRevision);
  assert.equal(f.remote.mergeCalls, 0);
}
async function ready(f) {
  const result = await runCanary(f.root, f.options, f.request);
  assert.equal(result.finalLifecycleState, 'MERGE_READY');
  assert.equal(result.status, 'STOPPED');
  await ensureCanaryPullRequest(f.root, f.options);
  f.remote.pr.draft = false; // External operator action in the isolated remote fixture.
}
async function validated(f) {
  const start = await createLocalDeveloperStartWorkflow(f.root);
  assert.equal(start.start(f.request).lifecycleState, 'IN_DEVELOPMENT');
  put(f.root, 'bootstrap/canary-proof.txt', marker);
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'Implement adversarial fixture change');
  const gate = await createLocalDeveloperValidationGate(f.root);
  const result = await gate.validate({ taskId, actorId: f.request.ownerId, runId: 'adversarial-validation', occurredAt: new Date().toISOString() });
  assert.equal(result.lifecycleState, 'DEV_VALIDATED');
  return result;
}
function reviewRequest(f, role, overrides = {}) {
  const revision = git(f.root, 'rev-parse', 'HEAD');
  return { taskId, reviewerId: `adversarial-${role}`, runId: `adversarial-${role}`, occurredAt: new Date().toISOString(),
    context: { schemaVersion: '1.0.0', role, taskId, sourceRevision: revision, task: { taskId }, artifacts: [], manifest: { included: [], excluded: [] } },
    outcome: 'PASS', findings: [], details: role === 'UAT/Product'
      ? { intendedOutcomesScenarios: ['Exercise the isolated fixture outcome.'], observedBehavior: ['The fixture source change is present.'] }
      : { affectedContractsModules: [], dependencyConsumerSurfaces: [], semanticCompatibilityAssessment: 'Fixture review input.', invariantDependencyRuleAssessment: 'Fixture review input.' },
    ...overrides };
}

for (const [id, problem, diagnostic] of [
  ['001', 'dependency cycle', 'TASK_DEPENDENCY_CYCLE'],
  ['002', 'missing dependency', 'TASK_DEPENDENCY_MISSING'],
]) {
  test(`ADV-${id} ${problem} prevents selection, assignment and branch creation`, async t => {
    const f = fixture(t);
    const task = definition(f);
    setDefinition(f, { ...task, dependencies: ['ADVERSARY-001'] });
    if (id === '001') put(f.root, 'tasks/definitions/adversary-001.task.json', JSON.stringify({
      ...task, taskId: 'ADVERSARY-001', canonicalBranch: 'bootstrap/adversary-001-fixture', dependencies: [taskId],
    }));
    git(f.root, 'add', '.'); git(f.root, 'commit', '-m', `Seed ${problem} task definitions`);
    f.initialRevision = git(f.root, 'rev-parse', 'main');
    const before = authoritativeFiles(f.root);
    const start = await createLocalDeveloperStartWorkflow(f.root);
    assert.throws(() => start.start(f.request), error => error instanceof DependencyDagValidationError && error.diagnostics.some(item => item.code === diagnostic));
    assert.deepEqual(authoritativeFiles(f.root), before);
    assert.equal(readLifecycle(f.root), null);
    assert.equal(git(f.root, 'branch', '--show-current'), 'main');
    assert.equal(git(f.root, 'branch', '--list', canonicalBranch), '');
    assert.equal(f.sessions.length, 0);
    assert.deepEqual(mutationCalls(f), []);
    assertNoCompletion(f);
  });
}

test('ADV-003 wrong Git branch cannot run validators or certify the assigned task', async t => {
  const f = fixture(t);
  (await createLocalDeveloperStartWorkflow(f.root)).start(f.request);
  git(f.root, 'switch', '-c', 'bootstrap/unrelated-fixture');
  const before = authoritativeFiles(f.root);
  const gate = await createLocalDeveloperValidationGate(f.root);
  await assert.rejects(gate.validate({ taskId, actorId: f.request.ownerId, runId: 'wrong-branch', occurredAt: new Date().toISOString() }),
    error => error.code === 'BRANCH_REJECTED');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.equal(readLifecycle(f.root).currentState, 'IN_DEVELOPMENT');
  assert.equal(evidence(f).getCurrent(validationEvidenceLineageId(taskId, 'repository:test')), null);
  assert.deepEqual(mutationCalls(f), []);
  assertNoCompletion(f);
});

function assignment(overrides = {}) {
  return { taskId, canonicalBranch, expectedCanonicalBranch: canonicalBranch, ownerId: 'lock-owner-a', runId: 'lock-run-a', lockId: 'lock-a',
    acquiredAt: '2026-10-12T00:00:00Z', expiresAt: '2026-10-12T01:00:00Z', ...overrides };
}
function acquireInProcess(root, request) {
  const moduleUrl = pathToFileURL(join(sourceRoot, 'dist/assignment-lock/index.js')).href;
  const script = `import {FileAssignmentLockStore} from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(JSON.stringify(new FileAssignmentLockStore(process.argv[1]).acquire(JSON.parse(process.argv[2]))));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Assignment worker exited ${code}: ${errors}`));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

test('ADV-004 simultaneous assignment contenders preserve exactly one owner', async t => {
  const f = fixture(t);
  const root = join(f.root, '.agent/state/assignments');
  // Initialize directories before the actual exclusive-create race.
  const store = new FileAssignmentLockStore(root);
  const requests = [assignment(), assignment({ ownerId: 'lock-owner-b', runId: 'lock-run-b', lockId: 'lock-b' })];
  const results = await Promise.all(requests.map(request => acquireInProcess(root, request)));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).rejection.code, 'LOCK_CONFLICT');
  const winner = store.get(taskId);
  assert.equal(winner.lockId, results.find(result => result.ok).lock.lockId);
  const before = authoritativeFiles(f.root);
  const losingRequest = requests.find(request => request.lockId !== winner.lockId);
  assert.equal(store.acquire(losingRequest).ok, false);
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.deepEqual(store.getAudit(taskId).map(event => event.action), ['ACQUIRED']);
  assert.equal(readLifecycle(f.root), null);
  assertNoCompletion(f);
});

test('ADV-005 stale assignment cannot be stolen; explicit recovery preserves its audit', t => {
  const f = fixture(t);
  const store = new FileAssignmentLockStore(join(f.root, '.agent/state/assignments'));
  assert.equal(store.acquire(assignment({ expiresAt: '2026-10-12T00:01:00Z' })).ok, true);
  const replacement = assignment({ ownerId: 'lock-owner-b', runId: 'lock-run-b', lockId: 'lock-b', acquiredAt: '2026-10-12T00:02:00Z' });
  const before = authoritativeFiles(f.root);
  const blocked = store.acquire(replacement);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.rejection.code, 'LOCK_STALE');
  assert.deepEqual(authoritativeFiles(f.root), before);
  const recovered = store.recoverStale({ ...replacement, expectedStaleLockId: 'lock-a', recoveryActorId: 'fixture-operator',
    recoveryRunId: 'fixture-recovery', recoveryReason: 'Isolated fixture owner stopped; explicit expired-lease recovery.' });
  assert.equal(recovered.ok, true);
  assert.equal(store.get(taskId).ownerId, 'lock-owner-b');
  assert.ok(store.getAudit(taskId).some(event => event.action === 'RECOVERED_STALE' && event.actorId === 'fixture-operator'));
  assert.ok(store.getAudit(taskId).some(event => event.action === 'ACQUIRED' && event.resultingLockId === 'lock-a'));
  assert.equal(readLifecycle(f.root), null);
  assertNoCompletion(f);
});

test('ADV-006 failed required command records failure without review, PR or completion', async t => {
  const f = fixture(t, { failingValidation: true });
  const result = await runCanary(f.root, f.options, f.request);
  assert.equal(result.finalLifecycleState, 'DEV_VALIDATION_FAILED');
  const record = evidence(f).getCurrent(validationEvidenceLineageId(taskId, 'repository:test'));
  assert.equal(record.payload.outcome, 'FAIL');
  assert.equal(record.payload.revisionIdentity, git(f.root, 'rev-parse', 'HEAD'));
  assert.ok(readLifecycle(f.root).history.every(event => event.toState !== 'DEV_VALIDATED'));
  assert.deepEqual(f.sessions.map(session => session.role), ['Developer']);
  assert.deepEqual(mutationCalls(f), []);
  assertNoCompletion(f);
});

test('ADV-007 developer self-approval cannot append an independent QA judgment', async t => {
  const f = fixture(t);
  await ready(f);
  const before = authoritativeFiles(f.root);
  const store = evidence(f);
  const framework = new ReviewFramework({ evidenceStore: store, evidenceLocation: join(f.root, '.agent/state/evidence') });
  const request = reviewRequest(f, 'QA', { reviewerId: f.request.ownerId });
  assert.throws(() => framework.submit({ ...request, role: 'QA', revisionIdentity: request.context.sourceRevision,
    contextPackage: request.context, evidenceRefs: [], details: { acceptanceCriteriaScenarios: ['fixture self-approval attack'], regressionNegativeCaseCoverage: ['actor identity'] } }),
  error => error.code === 'SELF_APPROVAL_REJECTED');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assertNoCompletion(f);
});

test('ADV-008 changed remote PR head blocks readiness without mutating approved local evidence', async t => {
  const f = fixture(t);
  await ready(f);
  const before = authoritativeFiles(f.root), mutations = mutationCalls(f);
  f.remote.headOverride = '2'.repeat(40);
  const result = await runCanary(f.root, { ...f.options, authorizedMergeHead: git(f.root, 'rev-parse', 'HEAD'), authorizedMergePr: 1 }, f.request);
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.stopped.stage, 'merge-readiness');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.deepEqual(mutationCalls(f), mutations);
  assertNoCompletion(f);
});

test('ADV-009 PR head changing after readiness is rejected before the merge endpoint', async t => {
  const f = fixture(t);
  await ready(f);
  const before = authoritativeFiles(f.root), mutations = mutationCalls(f);
  let rechecks = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && new URL(url).pathname.endsWith('/pulls/1')) {
      rechecks++;
      f.remote.headOverride = '3'.repeat(40); // Race after collection-based readiness reads.
    }
    return f.options.fetchImpl(url, init);
  };
  const controller = await createLocalControlledMergeController(f.root, { ...f.options, fetchImpl });
  await assert.rejects(controller.merge(mergeRequest()), error => error.code === 'HEAD_CHANGED');
  assert.equal(rechecks, 1, 'the controller must independently re-read the selected PR');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.deepEqual(mutationCalls(f), mutations, 'not even an attempted irreversible PUT is allowed');
  assertNoCompletion(f);
});

test('ADV-010 malformed evidence cannot replace or supersede recorded validation', async t => {
  const f = fixture(t);
  await validated(f);
  const store = evidence(f);
  const lineage = validationEvidenceLineageId(taskId, 'repository:test');
  const current = store.getCurrent(lineage);
  const before = authoritativeFiles(f.root);
  const rejected = store.record({ ...current.payload, evidenceId: 'malformed-adversarial-evidence', checks: 'green by assertion' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.rejection.code, 'SCHEMA_VALIDATION_FAILED');
  assert.deepEqual(store.getCurrent(lineage), current);
  assert.deepEqual(authoritativeFiles(f.root), before);
  assertNoCompletion(f);
});

test('ADV-011 a new source commit cannot reuse stale evidence for publication or merge', async t => {
  const f = fixture(t);
  await ready(f);
  const oldRevision = git(f.root, 'rev-parse', 'HEAD');
  const before = authoritativeFiles(f.root), mutations = mutationCalls(f);
  git(f.root, 'commit', '--allow-empty', '-m', 'Change source revision after approvals');
  const current = git(f.root, 'rev-parse', 'HEAD');
  assert.notEqual(current, oldRevision);
  assert.equal(evidence(f).checkRevision(validationEvidenceLineageId(taskId, 'repository:test'), current).status, 'REVISION_MISMATCH');
  await assert.rejects(ensureCanaryPullRequest(f.root, f.options), error => error.code === 'CANARY_STALE_EVIDENCE');
  const controller = await createLocalControlledMergeController(f.root, f.options);
  await assert.rejects(controller.merge(mergeRequest()), error => error.code === 'NOT_MERGE_READY');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.deepEqual(mutationCalls(f), mutations);
  assertNoCompletion(f);
});

test('ADV-012 skipping required QA, Architecture or UAT cannot advance validation into a merge', async t => {
  const f = fixture(t);
  await validated(f);
  const before = authoritativeFiles(f.root);
  for (const [role, create] of [['Architect', createLocalArchitectureReviewGate], ['UAT/Product', createLocalUatReviewGate]]) {
    const gate = await create(f.root);
    assert.throws(() => gate.review(reviewRequest(f, role)), error => error.code === 'TASK_STATE_NOT_REVIEWABLE');
    assert.equal(evidence(f).getCurrent(reviewResultLineageId(taskId, role)), null);
  }
  const controller = await createLocalControlledMergeController(f.root, f.options);
  await assert.rejects(controller.merge(mergeRequest()), error => error.code === 'TASK_STATE_NOT_MERGEABLE');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.equal(readLifecycle(f.root).currentState, 'DEV_VALIDATED');
  assert.deepEqual(mutationCalls(f), []);
  assertNoCompletion(f);
});

test('ADV-013 numeric producer still passes QA while range narrowing breaks its consumer and fails Architecture', async t => {
  const f = fixture(t);
  cpSync(join(sourceRoot, 'contracts/examples'), join(f.root, 'contracts/examples'), { recursive: true });
  const task = definition(f);
  setDefinition(f, { ...task, affectedContracts: ['example.range-provider', 'consumer.alerting'],
    allowedPaths: [...task.allowedPaths, 'fixture/**'], acceptanceCriteria: [...task.acceptanceCriteria, 'Preserve consumer.alerting reachable scores [90, 100].'] });
  put(f.root, 'fixture/range-provider.mjs', 'export function getScore(index = 100) { return Math.max(0, Math.min(100, Math.trunc(index))); }\n');
  put(f.root, 'fixture/alerting-consumer.mjs', 'export function onScore(score) { return score >= 90 && score <= 100; }\n');
  // Numeric QA checks genuinely execute the changed producer; they cannot certify consumer reachability.
  writeFileSync(join(f.root, 'verify.mjs'), `${readFileSync(join(f.root, 'verify.mjs'), 'utf8')}\nimport {getScore} from './fixture/range-provider.mjs';\nfor (let n=0;n<=100;n++) { const value=getScore(n); assert.ok(Number.isInteger(value) && value>=0 && value<=100); }\n`);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'Seed producer and consumer semantic contracts');
  f.initialRevision = git(f.root, 'rev-parse', 'main');
  const consumer = await import(pathToFileURL(join(f.root, 'fixture/alerting-consumer.mjs')).href);
  const original = await import(`${pathToFileURL(join(f.root, 'fixture/range-provider.mjs')).href}?original`);
  assert.equal(consumer.onScore(original.getScore(100)), true);
  put(f.root, 'fixture/range-provider.mjs', 'export function getScore(index = 100) { return Math.max(0, Math.min(89, Math.trunc(index))); }\n');
  await validated(f);
  execFileSync(process.execPath, ['verify.mjs'], { cwd: f.root, stdio: 'pipe' });
  const narrowed = await import(`${pathToFileURL(join(f.root, 'fixture/range-provider.mjs')).href}?narrowed`);
  assert.equal(typeof narrowed.getScore(100), 'number');
  assert.equal(consumer.onScore(narrowed.getScore(100)), false, 'same numeric interface has lost the consumer high-severity path');
  const qa = await createLocalQaReviewGate(f.root);
  const qaContext = qa.prepareContext({ taskId }).context;
  qa.review(reviewRequest(f, 'QA', { context: qaContext, details: { acceptanceCriteriaScenarios: ['Actual numeric/range verification executed for inputs 0 through 100.'],
    regressionNegativeCaseCoverage: ['Structural and accepted-range checks pass; downstream reachability requires Architect review.'] } }));
  assert.equal(readLifecycle(f.root).currentState, 'ARCHITECTURE_REVIEW');
  const store = evidence(f);
  const qaRecord = store.getCurrent(reviewResultLineageId(taskId, 'QA'));
  assert.equal(qaRecord.payload.outcome, 'PASS');
  const architect = await createLocalArchitectureReviewGate(f.root);
  const context = architect.prepareContext({ taskId }).context;
  assert.ok(context.artifacts.some(artifact => artifact.kind === 'consumer-requirement' && artifact.content.consumerId === 'consumer.alerting'));
  assert.ok(context.artifacts.some(artifact => artifact.kind === 'contract' && artifact.content.moduleId === 'consumer.alerting'));
  assert.ok(context.artifacts.some(artifact => artifact.kind === 'diff' && artifact.content.includes('Math.min(89')));
  const result = architect.review(reviewRequest(f, 'Architect', { context, outcome: 'FAIL', findings: [{ findingId: 'range-narrowing', severity: 'HIGH',
    observed: 'getScore now clamps all outputs to [0,89]; onScore(getScore(100)) is false.', expected: 'Consumer-required scores [90,100] remain reachable.',
    contractRef: 'example.range-provider', remediation: 'Restore producer reachability or explicitly renegotiate the consumer contract.' }],
    details: { affectedContractsModules: ['example.range-provider'], dependencyConsumerSurfaces: ['consumer.alerting'],
      semanticCompatibilityAssessment: 'Numeric QA passes while the required high-severity consumer path becomes unreachable.', invariantDependencyRuleAssessment: 'Required [90,100] reachability is broken.' },
    nonPass: { reason: 'Semantic range narrowing breaks the consumer.', remediation: 'Restore required reachability before a new review.' } }));
  assert.equal(result.lifecycleState, 'ARCHITECTURE_FAILED');
  assert.deepEqual(store.getCurrent(reviewResultLineageId(taskId, 'QA')), qaRecord, 'Architecture failure preserves the prior QA evidence');
  assert.equal(store.getCurrent(reviewResultLineageId(taskId, 'Architect')).payload.outcome, 'FAIL');
  const before = authoritativeFiles(f.root);
  const uat = await createLocalUatReviewGate(f.root);
  assert.throws(() => uat.review(reviewRequest(f, 'UAT/Product')), error => error.code === 'TASK_STATE_NOT_REVIEWABLE');
  const controller = await createLocalControlledMergeController(f.root, f.options);
  await assert.rejects(controller.merge(mergeRequest()), error => error.code === 'TASK_STATE_NOT_MERGEABLE');
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.ok(readLifecycle(f.root).history.every(event => !['UAT_REVIEW', 'MERGE_READY', 'MERGED', 'DONE'].includes(event.toState)));
  assert.deepEqual(mutationCalls(f), []);
  assertNoCompletion(f);
});

test('ADV-014 concurrent and completed duplicate merge attempts produce one merge and one completion', async t => {
  const f = fixture(t);
  await ready(f);
  const controllers = await Promise.all([createLocalControlledMergeController(f.root, f.options), createLocalControlledMergeController(f.root, f.options)]);
  const results = await Promise.allSettled(controllers.map(controller => controller.merge(mergeRequest())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'STATE_CONFLICT');
  assert.equal(f.remote.mergeCalls, 1);
  const state = readLifecycle(f.root);
  assert.equal(state.currentState, 'DONE');
  assert.equal(state.history.filter(event => event.toState === 'MERGED').length, 1);
  assert.equal(state.history.filter(event => event.toState === 'DONE').length, 1);
  const before = authoritativeFiles(f.root), calls = [...f.remote.calls];
  await controllers[0].merge(mergeRequest());
  assert.deepEqual(authoritativeFiles(f.root), before);
  assert.deepEqual(f.remote.calls, calls, 'completed reconciliation performs no provider call');
  assert.equal(f.remote.mergeCalls, 1);
  assert.equal(evidence(f).getHistory(`${taskId}::merge`).length, 1);
});

test('ADV-015 lost merge response and later branch drift reconcile without another irreversible call', async t => {
  const f = fixture(t);
  await ready(f);
  const controller = await createLocalControlledMergeController(f.root, f.options);
  const originalRevision = git(f.root, 'rev-parse', 'HEAD');
  f.remote.afterMerge = () => { throw new Error('fixture lost response after remote success'); };
  await assert.rejects(controller.merge(mergeRequest()), /lost response/);
  assert.equal(f.remote.mergeCalls, 1);
  assert.equal(readLifecycle(f.root).currentState, 'MERGE_READY');
  const before = readLifecycle(f.root).history;
  f.remote.afterMerge = null;
  git(f.root, 'commit', '--allow-empty', '-m', 'Later branch drift after confirmed remote success');
  await controller.merge(mergeRequest());
  assert.equal(readLifecycle(f.root).currentState, 'DONE');
  assert.deepEqual(readLifecycle(f.root).history.slice(0, before.length), before);
  assert.equal(evidence(f).getCurrent(`${taskId}::merge`).payload.revisionIdentity, originalRevision);
  assert.equal(f.remote.mergeCalls, 1);
});

test('ADV-016 missing or unsuccessful mandatory CI cannot be treated as green', async t => {
  const f = fixture(t);
  await ready(f);
  const before = authoritativeFiles(f.root), mutations = mutationCalls(f);
  for (const ci of ['missing', 'pending', 'failure', 'skipped', 'cancelled', 'timed_out']) {
    f.remote.ci = ci;
    const fetchImpl = async (url, init) => {
      const result = await f.options.fetchImpl(url, init);
      if (ci === 'missing' && new URL(url).pathname.endsWith('/check-runs')) return { ok: true, status: 200, json: async () => ({ check_runs: [] }) };
      return result;
    };
    const controller = await createLocalControlledMergeController(f.root, { ...f.options, fetchImpl });
    await assert.rejects(controller.merge(mergeRequest()), error => error.code === 'NOT_MERGE_READY', ci);
    assert.deepEqual(authoritativeFiles(f.root), before, ci);
    assert.deepEqual(mutationCalls(f), mutations, ci);
    assertNoCompletion(f);
  }
});
