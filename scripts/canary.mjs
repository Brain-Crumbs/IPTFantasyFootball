#!/usr/bin/env node
/** BOOT-033 deployment composition. The existing gates alone own state/evidence. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../dist/agent-provider/index.js';
import { createLocalArchitectureReviewGate } from '../dist/architecture-review/index.js';
import { createLocalControlledMergeController, GitHubControlledMergePullRequestOperations } from '../dist/controlled-merge/index.js';
import { createLocalDeveloperStartWorkflow, FileDeveloperStartStateStore } from '../dist/dev-start/index.js';
import { createLocalDeveloperValidationGate } from '../dist/dev-validation/index.js';
import { FileManualAgentProvider } from '../dist/local-agent-adapter/index.js';
import { createLocalMergeReadinessPolicyEngine } from '../dist/merge-readiness/index.js';
import { FileOrchestrationRunStore, SequentialOrchestrationEngine } from '../dist/orchestration-engine/index.js';
import { createLocalPullRequestLifecycleAdapter } from '../dist/pr-lifecycle/index.js';
import { createLocalQaReviewGate } from '../dist/qa-review/index.js';
import { createLocalReviewReworkGate } from '../dist/review-rework/index.js';
import { createLocalStatusDependencies, ProjectStatusReporter } from '../dist/status-reporting/index.js';
import { loadTaskRegistry } from '../dist/task-registry/index.js';
import { createLocalUatReviewGate } from '../dist/uat-review/index.js';
import { createLocalWorkflowDiagnostics } from '../dist/workflow-diagnostics/index.js';

export const CANARY_TASK_ID = 'CANARY-001';
export const CANARY_BRANCH = 'bootstrap/boot-033-canary-e2e';
const ROLES = ['Developer', 'QA', 'Architect', 'UAT/Product', 'MergeController'];
const SHA = /^[a-f0-9]{40}$/;
export class CanaryError extends Error {
  constructor(code, message) { super(message); this.name = 'CanaryError'; this.code = code; }
}
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cleanRevision(root, expected) {
  if (git(root, 'status', '--porcelain', '--untracked-files=normal') !== '') throw new CanaryError('CANARY_DIRTY_SOURCE', 'Canary requires a clean source tree, including untracked files. Commit the authorized source change before continuing.');
  const revision = git(root, 'rev-parse', 'HEAD');
  if (expected !== undefined && revision !== expected) throw new CanaryError('CANARY_HEAD_CHANGED', 'HEAD changed during a canary gate or review. Preserve evidence and use the owning rework/recovery workflow.');
  return revision;
}
function configCheck(options, requireRoles) {
  for (const name of ['owner', 'repo', 'token']) if (typeof options[name] !== 'string' || !options[name].trim()) throw new CanaryError('CANARY_INVALID_CONFIG', `${name} must be nonempty.`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(options.owner) || !/^[a-zA-Z0-9_.-]+$/.test(options.repo)) throw new CanaryError('CANARY_INVALID_CONFIG', 'GitHub owner/repo must be plain path components.');
  if (options.apiBaseUrl !== undefined || options.integrationTarget !== undefined || options.requiredCiChecks !== undefined) throw new CanaryError('CANARY_INVALID_CONFIG', 'Canary fixes GitHub, main and the existing required CI policy; these may not be overridden.');
  if (requireRoles) {
    const actors = ROLES.map(role => options.roleActors?.[role]);
    if (actors.some(actor => typeof actor !== 'string' || !actor.trim() || actor.trim() !== actor) || new Set(actors).size !== ROLES.length) throw new CanaryError('CANARY_INVALID_CONFIG', 'Explicit distinct roleActors are required for all five roles. Names do not establish actual session independence.');
    for (const role of ROLES) {
      const policy = options.rolePolicies?.[role];
      if (!policy || !Array.isArray(policy.allowedTools) || !['none', 'restricted', 'full'].includes(policy.networkAccess)) throw new CanaryError('CANARY_INVALID_CONFIG', `Explicit rolePolicies are required for ${role}. The operator must enforce them externally.`);
    }
  }
}
async function preflight(root, options, requireRoles) {
  configCheck(options, requireRoles);
  const actualRoot = realpathSync(root);
  if (realpathSync(git(actualRoot, 'rev-parse', '--show-toplevel')) !== actualRoot) throw new CanaryError('CANARY_WRONG_ROOT', 'Run from the repository root.');
  cleanRevision(actualRoot);
  const branch = git(actualRoot, 'branch', '--show-current');
  if (branch !== 'main' && branch !== CANARY_BRANCH) throw new CanaryError('CANARY_WRONG_BRANCH', `Canary starts on main or ${CANARY_BRANCH}, never an unrelated branch.`);
  const registry = await loadTaskRegistry({ repositoryRoot: actualRoot });
  const task = registry.get(CANARY_TASK_ID);
  if (registry.size !== 1 || !task || task.canonicalBranch !== CANARY_BRANCH || task.dependencies.length !== 0 || JSON.stringify([...task.requiredReviewRoles].sort()) !== JSON.stringify([...ROLES].sort())) {
    throw new CanaryError('CANARY_REGISTRY_MISMATCH', 'This bounded driver requires only CANARY-001, its canonical branch, no native dependencies, and all five review roles. It cannot select unrelated work.');
  }
  // Reports and provider files must not follow an operator-created symlink.
  for (const path of ['.agent', '.agent/canary-runs', '.agent/canary-exchange']) {
    const target = join(actualRoot, path);
    if (existsSync(target) && (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())) throw new CanaryError('CANARY_UNSAFE_OUTPUT', `${path} must be a real local directory.`);
  }
  return { root: actualRoot, registry };
}
function githubOptions(options) {
  const target = `https://api.github.com/repos/${options.owner}/${options.repo}/pulls`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return { owner: options.owner, repo: options.repo, token: options.token,
    fetchImpl: (url, init) => {
      if (url === target && init.method === 'POST') return fetchImpl(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), draft: true }) });
      return fetchImpl(url, init);
    } };
}
function redact(value, token) {
  if (typeof value === 'string') return value.split(token).join('[redacted]');
  if (Array.isArray(value)) return value.map(entry => redact(entry, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, token)]));
  return value;
}
async function makeReport(root, options, operation) {
  const invocationId = randomUUID();
  const directory = join(root, '.agent/canary-runs', invocationId);
  mkdirSync(directory, { recursive: true });
  const reportPath = join(directory, 'report.json');
  const captures = [];
  const now = options.now ?? (() => new Date().toISOString());
  const capture = async label => {
    const observedAt = now();
    const source = await createLocalStatusDependencies(root);
    const status = new ProjectStatusReporter(source).read(observedAt);
    const diagnostics = await createLocalWorkflowDiagnostics(root, { merge: githubOptions(options) });
    const safe = async fn => { try { return await fn(); } catch (error) { return { unavailable: true, code: error.code ?? null, message: error.message }; } };
    captures.push({ label, observedAt, sourceHead: git(root, 'rev-parse', 'HEAD'), status,
      diagnostics: { task: await safe(() => diagnostics.explainTask(CANARY_TASK_ID, observedAt)), validation: await safe(() => diagnostics.explainValidation(CANARY_TASK_ID, observedAt)),
        reviews: await safe(() => diagnostics.explainReviews(CANARY_TASK_ID, observedAt)), merge: await safe(() => diagnostics.explainMerge(CANARY_TASK_ID, observedAt)) } });
    // Each observation survives a crash while a later provider packet waits;
    // final report is only an index/summary, never workflow authority.
    const snapshotName = `${String(captures.length).padStart(3, '0')}-${label.replaceAll(/[^a-zA-Z0-9-]/g, '-')}.json`;
    writeFileSync(join(directory, snapshotName), `${JSON.stringify(redact(captures.at(-1), options.token), null, 2)}\n`, { flag: 'wx' });
  };
  const finish = outcome => {
    writeFileSync(reportPath, `${JSON.stringify(redact({ formatVersion: 1, invocationId, operation, taskId: CANARY_TASK_ID, canonicalBranch: CANARY_BRANCH,
      authority: 'Observations only. Native lifecycle, evidence, and remote GitHub facts remain authoritative. Injected fixture results are not live acceptance.', captures, ...outcome }, options.token), null, 2)}\n`, { flag: 'wx' });
  };
  return { invocationId, reportPath, capture, finish, now };
}

export async function runCanary(repositoryRoot, options, request) {
  const { root, registry } = await preflight(repositoryRoot, options, true);
  if (request.ownerId !== options.roleActors.Developer) throw new CanaryError('CANARY_ACTOR_MISMATCH', 'The request owner must be the configured Developer actor.');
  const report = await makeReport(root, options, 'run');
  try {
    await report.capture('before');
    const github = githubOptions(options);
    const [developerStart, developerValidation, qaReview, architectureReview, uatReview, reviewRework, mergeReadiness] = await Promise.all([
      createLocalDeveloperStartWorkflow(root), createLocalDeveloperValidationGate(root), createLocalQaReviewGate(root), createLocalArchitectureReviewGate(root),
      createLocalUatReviewGate(root), createLocalReviewReworkGate(root), createLocalMergeReadinessPolicyEngine(root, github),
    ]);
    const stateRoot = join(root, '.agent/state');
    const state = new FileDeveloperStartStateStore(join(stateRoot, 'lifecycle'));
    const provider = options.provider ?? new FileManualAgentProvider(join(root, '.agent/canary-exchange'), { repositoryRoot: root });
    const guardedProvider = { providerId: provider.providerId, capabilities: () => provider.capabilities(), run: async input => {
      const head = cleanRevision(root);
      await report.capture(`before-${input.role}`);
      const result = await provider.run(input);
      cleanRevision(root, input.role === 'Developer' ? undefined : head);
      await report.capture(`after-${input.role}`);
      return result;
    } };
    const guardGate = (gate, method) => ({ ...gate, [method]: async input => {
      const head = cleanRevision(root);
      const result = await gate[method](input);
      cleanRevision(root, head);
      await report.capture(`after-${method}`);
      return result;
    } });
    const guardedReview = gate => ({ prepareContext: input => gate.prepareContext(input), review: guardGate(gate, 'review').review });
    // Each controller call carries the same exact-target transport fence.
    // No policy result is replaced: the controller still independently
    // evaluates readiness and re-reads the PR before its merge operation.
    const mergeFetch = github.fetchImpl;
    github.fetchImpl = (url, init) => {
      if (init.method === 'PUT' && /\/pulls\/\d+\/merge$/.test(new URL(url).pathname)) {
        cleanRevision(root, options.authorizedMergeHead);
        const number = Number(new URL(url).pathname.split('/').at(-2));
        const body = JSON.parse(init.body);
        if (number !== options.authorizedMergePr || body.sha !== options.authorizedMergeHead) throw new CanaryError('CANARY_MERGE_AUTHORIZATION_MISMATCH', 'Actual pull request or head does not match explicit merge authorization.');
      }
      return mergeFetch(url, init);
    };
    // Keep all source-control effects behind the existing controller.
    const fencedController = await createLocalControlledMergeController(root, github);
    const guardedMerge = { merge: async input => {
      // DONE is a read-only controller path and requires no new permission.
      const head = cleanRevision(root);
      await report.capture('before-controlled-merge');
      if (state.get(CANARY_TASK_ID)?.currentState !== 'DONE') {
        if (!options.authorizedMergeHead || !Number.isSafeInteger(options.authorizedMergePr) || options.authorizedMergePr <= 0) throw new CanaryError('CANARY_MERGE_AUTHORIZATION_REQUIRED', 'Separate authorization identifying the exact PR and head is required before controlled merge. Preserve the same owner/run/key.');
        if (!SHA.test(options.authorizedMergeHead)) throw new CanaryError('CANARY_MERGE_AUTHORIZATION_MISMATCH', 'Authorized head must be a full source SHA.');
        if (options.authorizedMergeHead !== head) {
          // A successful remote merge may precede a local crash and later
          // branch drift. Confirm the exact authorized merged PR by read only;
          // BOOT-025 still verifies historical approval and owns reconciliation.
          const confirmed = await new GitHubControlledMergePullRequestOperations(github).getPullRequest(options.authorizedMergePr);
          if (!confirmed?.merged || confirmed.headSha !== options.authorizedMergeHead || confirmed.baseRef !== 'main' || !confirmed.mergeCommitSha) {
            throw new CanaryError('CANARY_MERGE_AUTHORIZATION_MISMATCH', 'Authorized head differs from current HEAD and the exact authorized PR is not confirmed merged.');
          }
        }
        if (state.get(CANARY_TASK_ID)?.currentState !== 'MERGED') {
          const readiness = await mergeReadiness.evaluate({ taskId: CANARY_TASK_ID });
          if (readiness.pullRequestNumber != null && readiness.pullRequestNumber !== options.authorizedMergePr) throw new CanaryError('CANARY_MERGE_AUTHORIZATION_MISMATCH', 'Authorized pull request differs from the policy-selected pull request.');
        }
      }
      return fencedController.merge(input);
    } };
    const engine = new SequentialOrchestrationEngine({ taskRegistry: registry, lifecycleState: { get: taskId => state.get(taskId) },
      runStore: new FileOrchestrationRunStore(join(stateRoot, 'orchestration')), developerStart,
      developerValidation: guardGate(developerValidation, 'validate'), qaReview: guardedReview(qaReview), architectureReview: guardedReview(architectureReview), uatReview: guardedReview(uatReview), reviewRework,
      mergeReadiness, controlledMerge: guardedMerge, agentRunner: new AgentRunner({ provider: guardedProvider }),
      actorIdFor: role => options.roleActors[role], toolPermissionPolicyFor: role => options.rolePolicies[role],
      ...(options.roleTimeoutMs === undefined ? {} : { timeoutMsFor: () => options.roleTimeoutMs }),
      ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }), now: report.now });
    const result = await engine.run(request);
    await report.capture('after');
    report.finish({ result });
    return { ...result, invocationId: report.invocationId, reportPath: report.reportPath };
  } catch (error) {
    try { await report.capture('stopped-with-error'); } catch (snapshotError) { /* Preserve the original blocker; final report still includes earlier captures. */ }
    report.finish({ error: { name: error.name, code: error.code ?? null, message: error.message } });
    error.reportPath = report.reportPath;
    throw error;
  }
}

export async function ensureCanaryPullRequest(repositoryRoot, options) {
  const { root } = await preflight(repositoryRoot, options, false);
  if (git(root, 'branch', '--show-current') !== CANARY_BRANCH) throw new CanaryError('CANARY_WRONG_BRANCH', 'Create the PR only from the canonical canary branch.');
  const source = await createLocalStatusDependencies(root);
  if (source.lifecycle.get(CANARY_TASK_ID)?.currentState !== 'MERGE_READY') throw new CanaryError('CANARY_NOT_REVIEWED', 'The canary PR step requires existing independent review gates to reach MERGE_READY.');
  const head = cleanRevision(root);
  const diagnostics = await createLocalWorkflowDiagnostics(root);
  const assertCurrentEvidence = () => {
    cleanRevision(root, head);
    const observedAt = (options.now ?? (() => new Date().toISOString()))();
    const validation = diagnostics.explainValidation(CANARY_TASK_ID, observedAt);
    const reviews = diagnostics.explainReviews(CANARY_TASK_ID, observedAt);
    if (validation.state !== 'MERGE_READY' || reviews.state !== 'MERGE_READY' || !validation.clear || !reviews.clear || validation.revision !== head || reviews.revision !== head) {
      throw new CanaryError('CANARY_STALE_EVIDENCE', 'PR creation/update requires current revision-bound validation and independent review evidence. Use the existing rework gates after source changes.');
    }
    cleanRevision(root, head);
  };
  assertCurrentEvidence();
  const report = await makeReport(root, options, 'pr');
  try {
    await report.capture('before-pr');
    const github = githubOptions(options);
    const originalFetch = github.fetchImpl;
    github.fetchImpl = (url, init) => {
      if (init.method === 'POST' || init.method === 'PATCH') assertCurrentEvidence();
      return originalFetch(url, init);
    };
    const adapter = await createLocalPullRequestLifecycleAdapter(root, github);
    assertCurrentEvidence();
    const result = await adapter.ensurePullRequest({ taskId: CANARY_TASK_ID, childIssueNumber: 35, parentIssueNumber: 1, expectedHead: CANARY_BRANCH, base: 'main' });
    cleanRevision(root, head);
    await report.capture('after-pr');
    report.finish({ result });
    return { ...result, invocationId: report.invocationId, reportPath: report.reportPath };
  } catch (error) {
    report.finish({ error: { code: error.code ?? null, message: error.message } }); error.reportPath = report.reportPath; throw error;
  }
}
async function main() {
  const [operation, configPath, requestPath, ...extra] = process.argv.slice(2);
  if (!['run', 'pr'].includes(operation) || !configPath || (operation === 'run' ? !requestPath : requestPath) || extra.length) throw new CanaryError('CANARY_USAGE', 'Usage: node scripts/canary.mjs run <config.json> <request.json> | pr <config.json>');
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
  if ('token' in config || 'fetchImpl' in config || 'provider' in config || 'now' in config) throw new CanaryError('CANARY_INVALID_CONFIG', 'Config cannot contain credentials or injected runtime adapters. Use existing IPT_GITHUB_TOKEN environment configuration.');
  const options = { ...config, token: process.env.IPT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN };
  const root = process.cwd();
  const result = operation === 'run' ? await runCanary(root, options, JSON.parse(readFileSync(resolve(requestPath), 'utf8'))) : await ensureCanaryPullRequest(root, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'CANARY_ERROR', message: error.message, reportPath: error.reportPath ?? null })}\n`); process.exitCode = 1;
});
