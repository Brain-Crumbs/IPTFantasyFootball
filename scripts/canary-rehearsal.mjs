#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCanary, ensureCanaryPullRequest } from './canary.mjs';
import { authoritativeFiles, createCanaryFixture, git, readLifecycle, sourceRoot } from '../tests/helpers/canary-fixture.mjs';

// This named rehearsal creates only a fresh local fixture. Its injected HTTP
// boundary never forwards to the network, and it has no real credentials.
const parentDirectory = resolve(process.argv[2] ?? join(sourceRoot, '.agent/canary-rehearsals'));
mkdirSync(parentDirectory, { recursive: true });
const fixture = createCanaryFixture({ parentDirectory });
const { root, options, request, remote, sessions, initialRevision } = fixture;
const reports = [];
try {
  reports.push(await runCanary(root, options, request));
  assert.equal(reports.at(-1).finalLifecycleState, 'MERGE_READY');
  const pullRequest = await ensureCanaryPullRequest(root, options);
  assert.equal(pullRequest.number, 1);
  let authorizationStopReportPath;
  await assert.rejects(runCanary(root, options, request), error => {
    authorizationStopReportPath = error.reportPath;
    return error.code === 'CANARY_MERGE_AUTHORIZATION_REQUIRED';
  });
  assert.equal(remote.mergeCalls, 0);
  // Fixture operator approves this isolated PR only. This cannot authorize a
  // GitHub merge, supply live review evidence, or accept BOOT-033.
  remote.pr.draft = false;
  const authorized = { ...options, authorizedMergeHead: git(root, 'rev-parse', 'HEAD'), authorizedMergePr: 1 };
  reports.push(await runCanary(root, authorized, request));
  assert.equal(reports.at(-1).finalLifecycleState, 'DONE');
  const completeState = authoritativeFiles(root);
  reports.push(await runCanary(root, authorized, request));
  assert.equal(reports.at(-1).finalLifecycleState, 'DONE');
  assert.deepEqual(authoritativeFiles(root), completeState);
  assert.equal(remote.mergeCalls, 1);
  assert.equal(sessions.length, 4);
  const summary = {
    kind: 'ISOLATED_REHEARSAL_ONLY',
    limitation: 'Scripted role results and simulated GitHub PR/CI HTTP boundary are not independent live approvals or a live GitHub merge. No live issue completion or v1 cutover is established.',
    sourceRevision: git(sourceRoot, 'rev-parse', 'HEAD'),
    fixtureRoot: root, initialRevision, implementationRevision: authorized.authorizedMergeHead,
    mergeRevision: git(root, 'rev-parse', 'main'),
    request, finalLifecycleState: readLifecycle(root).currentState,
    reportPaths: [...reports.map(report => report.reportPath), pullRequest.reportPath, authorizationStopReportPath],
    packetIds: sessions.map(packet => packet.packetId),
    roleSessions: sessions.map(packet => ({ role: packet.role, actorId: packet.actorId, runId: packet.runId, revisionIdentity: packet.revisionIdentity })),
    lifecycleStages: readLifecycle(root).history.map(event => ({ state: event.toState, evidenceRef: event.evidenceRef, revisionIdentity: event.revisionIdentity ?? null })),
    fixturePullRequestCreates: remote.createCalls, fixtureMergeCalls: remote.mergeCalls,
    completedReconciliationIdentical: true,
  };
  const summaryPath = join(root, '.agent/summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ ok: true, kind: summary.kind, finalLifecycleState: summary.finalLifecycleState, summaryPath, fixtureRoot: root }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, fixtureRoot: root, message: error.message, code: error.code ?? null, reportPath: error.reportPath ?? null }, null, 2)}\n`);
  process.exitCode = 1;
}
