import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileManualAgentProvider } from '../../dist/local-agent-adapter/index.js';

export const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
export const canonicalBranch = 'bootstrap/boot-033-canary-e2e';
export const taskId = 'CANARY-001';
export const marker = 'IPT control plane canary v1\n';
export const roles = ['Developer', 'QA', 'Architect', 'UAT/Product', 'MergeController'];
export function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function put(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}
export function readLifecycle(root) {
  const path = join(root, '.agent/state/lifecycle', `${taskId}.lifecycle.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
export function authoritativeFiles(root) {
  const result = {};
  function visit(path, prefix = '') {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), `${relative}/`);
      else result[relative] = readFileSync(join(path, entry.name), 'utf8');
    }
  }
  for (const family of ['lifecycle', 'evidence', 'assignments']) visit(join(root, '.agent/state', family), `${family}/`);
  return result;
}

/** Creates an isolated real Git repository. No live credentials or network calls. */
export function createCanaryFixture({ parentDirectory, reviewFailure, dirtyDeveloper = false, failingValidation = false } = {}) {
  const root = mkdtempSync(join(parentDirectory ?? tmpdir(), 'ipt-canary-'));
  cpSync(join(sourceRoot, 'schemas'), join(root, 'schemas'), { recursive: true });
  const definition = readFileSync(join(sourceRoot, 'tasks/definitions/canary-001.task.json'), 'utf8');
  // This is a task definition, never a lifecycle/evidence record. Seed it in
  // the clean base just as a repository would register an upcoming task.
  put(root, 'tasks/definitions/canary-001.task.json', definition);
  put(root, '.gitignore', '.agent/\n');
  put(root, '.npmrc', 'offline=true\nupdate-notifier=false\naudit=false\nfund=false\n');
  put(root, 'package.json', JSON.stringify({ name: 'isolated-canary-fixture', private: true, type: 'module',
    scripts: { build: 'node --check verify.mjs', test: 'node verify.mjs' } }, null, 2));
  put(root, 'verify.mjs', `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nassert.equal(readFileSync('bootstrap/canary-proof.txt', 'utf8'), ${JSON.stringify(marker)});\n${failingValidation ? "throw new Error('deliberate fixture validation failure');\n" : ''}`);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Isolated canary fixture');
  git(root, 'config', 'user.email', 'canary-fixture@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Seed isolated canary task and deterministic validators');
  const initialRevision = git(root, 'rev-parse', 'HEAD');
  const request = { ownerId: 'fixture-developer', runId: 'fixture-canary-1', idempotencyKey: 'fixture-canary-1', occurredAt: new Date().toISOString() };
  const roleActors = Object.fromEntries(roles.map(role => [role, role === 'Developer' ? request.ownerId : `fixture-${role.toLowerCase().replaceAll('/', '-')}`]));
  const rolePolicies = Object.fromEntries(roles.map(role => [role, { allowedTools: role === 'Developer' ? ['read_file', 'write_file', 'git_commit'] : ['read_file', 'run_test'], deniedTools: ['live_network', 'live_merge'], networkAccess: 'none' }]));
  const exchange = new FileManualAgentProvider(join(root, '.agent/canary-exchange'), { repositoryRoot: root });
  const sessions = [];
  const provider = {
    providerId: exchange.providerId,
    capabilities: () => exchange.capabilities(),
    async run(request) {
      const packet = exchange.exportPacket(request);
      sessions.push(packet);
      if (request.role === 'Developer') {
        put(root, 'bootstrap/canary-proof.txt', marker);
        if (!dirtyDeveloper) {
          git(root, 'add', 'bootstrap/canary-proof.txt');
          git(root, 'commit', '-m', 'Implement tiny canary marker');
        }
      }
      const outcome = reviewFailure === request.role ? 'FAIL' : 'PASS';
      const details = request.role === 'QA' ? { acceptanceCriteriaScenarios: ['fixture marker exact bytes'], regressionNegativeCaseCoverage: ['fixture missing or invalid marker rejected'] }
        : request.role === 'Architect' ? { affectedContractsModules: [], dependencyConsumerSurfaces: [], semanticCompatibilityAssessment: 'Fixture-only marker adds no runtime capability.', invariantDependencyRuleAssessment: 'Fixture gates and stores remain authoritative.' }
          : request.role === 'UAT/Product' ? { intendedOutcomesScenarios: ['fixture tiny repository change can complete through the control plane'], observedBehavior: ['fixture marker exists at exact reviewed revision'] }
            : { summary: 'Scripted fixture implementation; not independent live approval.' };
      const result = { runId: request.runId, providerId: exchange.providerId, taskId: request.taskId, role: request.role,
        revisionIdentity: request.revisionIdentity, outcome, details, findings: outcome === 'PASS' ? [] : [{ findingId: 'fixture-rejection', severity: 'HIGH', observed: 'Deliberate fixture rejection', expected: 'Required role approval' }],
        evidenceRefs: [], occurredAt: new Date().toISOString(),
        ...(outcome === 'PASS' ? {} : { nonPass: { reason: 'Deliberate fixture rejection', remediation: 'Use normal rework, never overwrite this result.' } }) };
      exchange.importResult(packet.packetId, { schemaId: 'ipt.local-agent-result', schemaVersion: '1.0.0', ...packet.resultBinding, status: 'COMPLETED', result });
      return exchange.run(request);
    },
  };
  const remote = { pr: null, ci: 'success', calls: [], mergeCalls: 0, createCalls: 0, headOverride: null, baseOverride: null, beforeMerge: null, afterMerge: null };
  function prRecord() {
    if (!remote.pr) return null;
    return { ...remote.pr, head: { ref: canonicalBranch, sha: remote.headOverride ?? remote.pr.merged_head ?? git(root, 'rev-parse', canonicalBranch) }, base: { ref: remote.baseOverride ?? 'main' } };
  }
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.github.com');
    assert.ok(u.pathname.startsWith('/repos/fixture-owner/fixture-repo/'), 'fixture adapter rejects any live repository destination');
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? null : JSON.parse(init.body);
    remote.calls.push({ method, path: u.pathname, query: u.search, body });
    const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
    if (u.pathname.endsWith('/check-runs') && method === 'GET') {
      const revision = u.pathname.split('/').at(-2);
      assert.equal(revision, git(root, 'rev-parse', canonicalBranch));
      return response({ check_runs: [{ name: u.searchParams.get('check_name'), status: remote.ci === 'pending' ? 'in_progress' : 'completed', conclusion: remote.ci === 'pending' ? null : remote.ci, started_at: new Date().toISOString() }] });
    }
    if (u.pathname.endsWith('/pulls') && method === 'POST') {
      assert.equal(body.head, canonicalBranch);
      assert.equal(body.base, 'main');
      assert.equal(body.draft, true, 'new canary PR must be draft');
      remote.createCalls++;
      remote.pr = { number: 1, html_url: 'https://github.com/fixture-owner/fixture-repo/pull/1', title: body.title, body: body.body,
        state: 'open', draft: body.draft, merged: false, merged_at: null, merge_commit_sha: null };
      return response(prRecord());
    }
    if (u.pathname.endsWith('/pulls') && method === 'GET') {
      const pr = prRecord();
      return response(pr && (u.searchParams.get('state') !== 'open' || pr.state === 'open') ? [pr] : []);
    }
    if (u.pathname.endsWith('/pulls/1') && method === 'PATCH') {
      Object.assign(remote.pr, body);
      return response(prRecord());
    }
    if (u.pathname.endsWith('/pulls/1') && method === 'GET') return response(prRecord());
    if (u.pathname.endsWith('/pulls/1/merge') && method === 'PUT') {
      remote.beforeMerge?.();
      assert.equal(body.sha, prRecord().head.sha);
      assert.equal(remote.pr.state, 'open');
      assert.equal(remote.pr.draft, false, 'fixture operator must release draft after review');
      assert.equal(remote.ci, 'success');
      remote.mergeCalls++;
      // This models the remote Git operation using real Git in the isolated
      // fixture only. It can never touch the implementation checkout's main.
      git(root, 'switch', 'main');
      try { git(root, 'merge', '--no-ff', canonicalBranch, '-m', 'Fixture controlled canary merge'); }
      finally { git(root, 'switch', canonicalBranch); }
      remote.pr.merged_head = body.sha; remote.pr.state = 'closed'; remote.pr.merged = true; remote.pr.merged_at = new Date().toISOString();
      remote.pr.merge_commit_sha = git(root, 'rev-parse', 'main');
      remote.afterMerge?.();
      return response({ merged: true, sha: remote.pr.merge_commit_sha, message: 'Isolated fixture merge only' });
    }
    throw new Error(`Unexpected fixture HTTP operation: ${method} ${url}`);
  };
  const options = { owner: 'fixture-owner', repo: 'fixture-repo', token: 'fixture-not-a-credential', provider, fetchImpl, roleActors, rolePolicies };
  return { root, options, request, remote, sessions, initialRevision, exchange };
}
