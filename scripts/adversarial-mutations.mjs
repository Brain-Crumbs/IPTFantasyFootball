#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mutation proof runs only in disposable copies. It never edits the source
// checkout, its compiled runtime, Git refs or operational .agent state.
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const mutations = [
  { id: 'SELF_APPROVAL', test: 'ADV-007', file: 'dist/review-framework/review-framework.js',
    from: 'developerRecord.payload.reviewerId === request.reviewerId', to: 'false /* isolated mutation: self-approval allowed */' },
  { id: 'PRE_MERGE_HEAD', test: 'ADV-009', file: 'dist/controlled-merge/controlled-merge.js',
    from: 'recheck.headSha !== revision', to: 'false /* isolated mutation: moved head allowed */' },
];

function run(root, id) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', `^${id} `, 'tests/adversarial-workflow.test.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.signal) throw new Error(`${id} failed to execute: ${result.error?.message ?? result.signal}`);
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

for (const mutation of mutations) {
  const root = mkdtempSync(join(tmpdir(), 'ipt-adversarial-mutation-'));
  try {
    for (const directory of ['dist', 'schemas', 'tasks', 'contracts']) cpSync(join(sourceRoot, directory), join(root, directory), { recursive: true });
    for (const file of ['package.json', 'scripts/canary.mjs', 'tests/adversarial-workflow.test.mjs', 'tests/helpers/canary-fixture.mjs']) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      cpSync(join(sourceRoot, file), join(root, file));
    }
    const baseline = run(root, mutation.test);
    assert.equal(baseline.status, 0, `${mutation.test} unmodified baseline failed:\n${baseline.output}`);
    assert.match(baseline.output, new RegExp(`^ok \\d+ - ${mutation.test} `, 'm'), 'baseline must execute the named test');
    const path = join(root, mutation.file);
    const original = readFileSync(path, 'utf8');
    assert.equal(original.split(mutation.from).length - 1, 1, `${mutation.id} guard anchor must exist exactly once; refresh proof if implementation changes`);
    writeFileSync(path, original.replace(mutation.from, mutation.to));
    const weakened = run(root, mutation.test);
    assert.equal(weakened.status, 1, `${mutation.id} survived or had an infrastructure failure:\n${weakened.output}`);
    assert.match(weakened.output, new RegExp(`^not ok \\d+ - ${mutation.test} `, 'm'), 'the corresponding safety test must fail');
    assert.match(weakened.output, /ERR_ASSERTION/, 'the mutant must be rejected by a test assertion, not a loader/syntax failure');
    process.stdout.write(`${mutation.id}: ${mutation.test} baseline PASS; weakened guard detected\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
