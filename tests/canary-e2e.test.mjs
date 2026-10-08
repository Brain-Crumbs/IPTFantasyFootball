import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCanary, ensureCanaryPullRequest } from '../scripts/canary.mjs';
import { createLocalStatusDependencies, ProjectStatusReporter } from '../dist/status-reporting/index.js';
import { createLocalWorkflowDiagnostics } from '../dist/workflow-diagnostics/index.js';
import { FileEvidenceStore } from '../dist/evidence-store/index.js';
import { authoritativeFiles, canonicalBranch, createCanaryFixture, git, marker, readLifecycle, sourceRoot, taskId } from './helpers/canary-fixture.mjs';

function fixture(t, options = {}) {
  const f = createCanaryFixture(options);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}
async function ready(f) {
  const result = await runCanary(f.root, f.options, f.request);
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.finalLifecycleState, 'MERGE_READY');
  assert.equal(result.stopped.stage, 'merge-readiness');
  assert.equal(f.remote.mergeCalls, 0);
  const pr = await ensureCanaryPullRequest(f.root, f.options);
  assert.equal(pr.number, 1);
  return result;
}
function authorized(f) {
  return { ...f.options, authorizedMergeHead: git(f.root, 'rev-parse', 'HEAD'), authorizedMergePr: 1 };
}

test('real repository includes the exact tiny canary marker and schema-valid task definition', () => {
  assert.equal(readFileSync(join(sourceRoot, 'bootstrap/canary-proof.txt'), 'utf8'), marker);
  const task = JSON.parse(readFileSync(join(sourceRoot, 'tasks/definitions/canary-001.task.json'), 'utf8'));
  assert.equal(task.taskId, taskId);
  assert.equal(task.canonicalBranch, canonicalBranch);
  assert.deepEqual(task.dependencies, []);
  assert.deepEqual(task.requiredReviewRoles, ['Developer', 'QA', 'Architect', 'UAT/Product', 'MergeController']);
});

test('isolated complete canary uses real selection, Git, command validation, role gates, evidence, merge and idempotent DONE', async t => {
  const f = fixture(t);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main');
  assert.equal(readLifecycle(f.root), null);
  const before = new ProjectStatusReporter(await createLocalStatusDependencies(f.root)).read(new Date().toISOString());
  assert.equal(before.next.kind, 'selected');
  assert.equal(before.next.taskId, taskId);
  const pending = await ready(f);
  const finalRevision = git(f.root, 'rev-parse', 'HEAD');
  assert.notEqual(finalRevision, f.initialRevision, 'Developer produced an actual implementation commit');
  assert.equal(git(f.root, 'branch', '--show-current'), canonicalBranch);
  assert.equal(readFileSync(join(f.root, 'bootstrap/canary-proof.txt'), 'utf8'), marker);
  assert.deepEqual(f.sessions.map(p => p.role), ['Developer', 'QA', 'Architect', 'UAT/Product']);
  assert.equal(f.sessions[0].revisionIdentity, f.initialRevision);
  assert.ok(f.sessions.slice(1).every(p => p.revisionIdentity === finalRevision));
  assert.equal(new Set(f.sessions.map(p => p.actorId)).size, 4);
  assert.equal(new Set(f.sessions.map(p => p.runId)).size, 4);
  const history = readLifecycle(f.root).history;
  assert.deepEqual(history.map(e => e.toState), ['READY', 'ASSIGNED', 'IN_DEVELOPMENT', 'DEV_VALIDATED', 'QA_REVIEW', 'ARCHITECTURE_REVIEW', 'UAT_REVIEW', 'MERGE_READY']);
  assert.ok(history.slice(3).every(e => e.revisionIdentity === finalRevision));
  const evidence = new FileEvidenceStore(join(f.root, '.agent/state/evidence'), { repositoryRoot: f.root, readOnly: true });
  for (const id of ['repository:build', 'repository:test']) {
    const record = evidence.getCurrent(`${taskId}::validator::${id}`);
    assert.equal(record.payload.outcome, 'PASS');
    assert.equal(record.payload.revisionIdentity, finalRevision);
  }
  for (const role of ['Developer', 'QA', 'Architect', 'UAT/Product']) {
    const record = evidence.getCurrent(`${taskId}::role::${role}`);
    assert.equal(record.payload.outcome, 'PASS');
    assert.equal(record.payload.revisionIdentity, finalRevision);
  }
  assert.equal(f.remote.createCalls, 1);
  assert.equal(f.remote.pr.draft, true);
  const againPr = await ensureCanaryPullRequest(f.root, f.options);
  assert.equal(againPr.created, false);
  assert.equal(f.remote.createCalls, 1);
  const beforeAuthorization = authoritativeFiles(f.root);
  await assert.rejects(runCanary(f.root, f.options, f.request), error => error.code === 'CANARY_MERGE_AUTHORIZATION_REQUIRED');
  assert.deepEqual(authoritativeFiles(f.root), beforeAuthorization, 'authorization pause must not mutate lifecycle/evidence/assignment');
  assert.equal(f.remote.mergeCalls, 0);
  assert.equal(f.sessions.length, 4, 'same-key retry reuses role results');
  f.remote.pr.draft = false; // External fixture operator action, not source-state mutation.
  const completed = await runCanary(f.root, authorized(f), f.request);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.finalLifecycleState, 'DONE');
  assert.equal(f.remote.mergeCalls, 1);
  assert.equal(completed.mergeCommitSha, git(f.root, 'rev-parse', 'main'));
  assert.equal(git(f.root, 'show', 'main:bootstrap/canary-proof.txt'), marker.trim());
  assert.deepEqual(readLifecycle(f.root).history.slice(-2).map(e => e.toState), ['MERGED', 'DONE']);
  const after = new ProjectStatusReporter(await createLocalStatusDependencies(f.root)).read(new Date().toISOString());
  assert.equal(after.tasks[0].state, 'DONE');
  assert.equal(after.tasks[0].assignment, null);
  assert.equal(after.next.kind, 'complete');
  const diagnostics = await createLocalWorkflowDiagnostics(f.root, { merge: f.options });
  assert.equal(diagnostics.explainValidation(taskId, new Date().toISOString()).clear, true);
  assert.equal(diagnostics.explainReviews(taskId, new Date().toISOString()).clear, true);
  const persisted = authoritativeFiles(f.root);
  const reconciled = await runCanary(f.root, authorized(f), f.request);
  assert.equal(reconciled.status, 'COMPLETED');
  assert.equal(reconciled.mergeCommitSha, completed.mergeCommitSha);
  assert.deepEqual(authoritativeFiles(f.root), persisted);
  assert.equal(f.remote.mergeCalls, 1);
  assert.equal(f.sessions.length, 4);
  for (const result of [pending, completed, reconciled]) {
    assert.ok(existsSync(result.reportPath));
    assert.ok(!readFileSync(result.reportPath, 'utf8').includes('fixture-not-a-credential'));
  }
});

test('pending and failing exact-head CI block controlled merge; later same-key success resumes', async t => {
  const f = fixture(t);
  await ready(f);
  f.remote.pr.draft = false;
  for (const ci of ['pending', 'failure']) {
    f.remote.ci = ci;
    const result = await runCanary(f.root, authorized(f), f.request);
    assert.equal(result.status, 'STOPPED');
    assert.equal(result.finalLifecycleState, 'MERGE_READY');
    assert.equal(f.remote.mergeCalls, 0);
  }
  f.remote.ci = 'success';
  assert.equal((await runCanary(f.root, authorized(f), f.request)).finalLifecycleState, 'DONE');
  assert.equal(f.sessions.length, 4);
});

test('wrong head authorization and wrong PR authorization cannot invoke merge', async t => {
  const f = fixture(t);
  await ready(f);
  for (const options of [{ ...authorized(f), authorizedMergeHead: '1'.repeat(40) }, { ...authorized(f), authorizedMergePr: 2 }]) {
    await assert.rejects(runCanary(f.root, options, f.request), /authoriz|head|pull request/i);
    assert.equal(f.remote.mergeCalls, 0);
    assert.equal(readLifecycle(f.root).currentState, 'MERGE_READY');
  }
});

test('moved remote head and wrong PR base remain policy blockers', async t => {
  const f = fixture(t);
  await ready(f);
  f.remote.headOverride = '2'.repeat(40);
  const moved = await runCanary(f.root, authorized(f), f.request);
  assert.equal(moved.status, 'STOPPED');
  assert.equal(f.remote.mergeCalls, 0);
  f.remote.headOverride = null; f.remote.baseOverride = 'other';
  const wrongBase = await runCanary(f.root, authorized(f), f.request);
  assert.equal(wrongBase.status, 'STOPPED');
  assert.equal(f.remote.mergeCalls, 0);
});

test('required QA rejection persists real failure and routes rework before later sessions or PR', async t => {
  const f = fixture(t, { reviewFailure: 'QA' });
  const result = await runCanary(f.root, f.options, f.request);
  assert.equal(result.status, 'STOPPED');
  assert.equal(result.finalLifecycleState, 'REWORK_REQUIRED');
  assert.deepEqual(f.sessions.map(p => p.role), ['Developer', 'QA']);
  assert.equal(f.remote.createCalls, 0);
  assert.equal(f.remote.mergeCalls, 0);
  const unchanged = authoritativeFiles(f.root);
  assert.equal((await runCanary(f.root, f.options, f.request)).status, 'STOPPED');
  assert.deepEqual(authoritativeFiles(f.root), unchanged);
});

test('actual command validation failure stops before reviewers and any PR mutation', async t => {
  const f = fixture(t, { failingValidation: true });
  const result = await runCanary(f.root, f.options, f.request);
  assert.equal(result.finalLifecycleState, 'DEV_VALIDATION_FAILED');
  assert.deepEqual(f.sessions.map(p => p.role), ['Developer']);
  assert.equal(f.remote.createCalls, 0);
});

test('dirty source and unrelated registered work fail closed before assignment', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'untracked.txt'), 'uncommitted source');
  await assert.rejects(runCanary(f.root, f.options, f.request), /clean|dirty|untracked/i);
  assert.equal(readLifecycle(f.root), null);
  rmSync(join(f.root, 'untracked.txt'));
  const taskPath = join(f.root, 'tasks/definitions/canary-001.task.json');
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  writeFileSync(join(f.root, 'tasks/definitions/other.task.json'), JSON.stringify({ ...task, taskId: 'OTHER-001', canonicalBranch: 'bootstrap/other-001' }));
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'Add unrelated registered task fixture');
  await assert.rejects(runCanary(f.root, f.options, f.request), /registry|task|canary/i);
  assert.equal(readLifecycle(f.root), null);
  assert.equal(f.sessions.length, 0);
});

test('uncommitted Developer output cannot be certified against the old HEAD', async t => {
  const f = fixture(t, { dirtyDeveloper: true });
  await assert.rejects(runCanary(f.root, f.options, f.request), /clean|dirty|untracked/i);
  assert.equal(readLifecycle(f.root).currentState, 'IN_DEVELOPMENT');
  assert.deepEqual(f.sessions.map(p => p.role), ['Developer']);
  assert.equal(f.remote.mergeCalls, 0);
});


test('clean new source revision refuses stale-evidence PR creation or updates', async t => {
  const f = fixture(t);
  await ready(f);
  const mutations = f.remote.calls.filter(call => call.method !== 'GET').length;
  git(f.root, 'commit', '--allow-empty', '-m', 'New revision invalidates approvals');
  await assert.rejects(ensureCanaryPullRequest(f.root, f.options), error => error.code === 'CANARY_STALE_EVIDENCE');
  assert.equal(f.remote.calls.filter(call => call.method !== 'GET').length, mutations);
});

test('lost merge response followed by branch drift reconciles original confirmed merge without another PUT', async t => {
  const f = fixture(t);
  await ready(f);
  const approval = authorized(f);
  f.remote.pr.draft = false;
  f.remote.afterMerge = () => { throw new Error('fixture lost response after remote merge committed'); };
  await assert.rejects(runCanary(f.root, approval, f.request), /lost response/);
  assert.equal(f.remote.mergeCalls, 1);
  assert.equal(readLifecycle(f.root).currentState, 'MERGE_READY');
  f.remote.afterMerge = null;
  git(f.root, 'commit', '--allow-empty', '-m', 'Later branch drift after remote success');
  assert.notEqual(git(f.root, 'rev-parse', 'HEAD'), approval.authorizedMergeHead);
  const reconciled = await runCanary(f.root, approval, f.request);
  assert.equal(reconciled.finalLifecycleState, 'DONE');
  assert.equal(reconciled.mergeCommitSha, f.remote.pr.merge_commit_sha);
  assert.equal(f.remote.mergeCalls, 1);
  const doneState = authoritativeFiles(f.root);
  const again = await runCanary(f.root, f.options, f.request);
  assert.equal(again.finalLifecycleState, 'DONE');
  assert.deepEqual(authoritativeFiles(f.root), doneState);
  assert.equal(f.remote.mergeCalls, 1);
});

test('PR mutation fences reject a commit landing during provider lookup before POST or PATCH', async t => {
  const f = fixture(t);
  const first = await runCanary(f.root, f.options, f.request);
  assert.equal(first.finalLifecycleState, 'MERGE_READY');
  let lookups = 0;
  const original = f.options.fetchImpl;
  const raced = { ...f.options, fetchImpl: async (url, init) => {
    const result = await original(url, init);
    if (init.method === 'GET' && new URL(url).pathname.endsWith('/pulls') && ++lookups === 2) {
      git(f.root, 'commit', '--allow-empty', '-m', 'Race: source changes during PR lookup');
    }
    return result;
  } };
  await assert.rejects(ensureCanaryPullRequest(f.root, raced), /HEAD changed|stale|current/i);
  assert.equal(f.remote.createCalls, 0);
  assert.equal(f.remote.calls.filter(call => call.method !== 'GET').length, 0);
});
