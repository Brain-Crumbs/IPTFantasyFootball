import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const config = JSON.parse(read('vibez.config.json'));

test('the configured required checks run against the exact PR head', () => {
  assert.deepEqual(config.policy.requiredChecks, [
    'Build and test (Node)',
    'Schema and contract validation (Python)',
    'Installed consumer (Ubuntu)',
    'Installed consumer (Windows)',
  ]);
  for (const check of config.policy.requiredChecks.slice(0, 2)) assert.ok(workflow.includes('name: ' + check));
  assert.match(workflow, /name: Installed consumer \(\$\{\{ matrix\.platform \}\}\)/);
  for (const platform of ['Ubuntu', 'Windows']) assert.ok(workflow.includes('platform: ' + platform));
  const checkouts = [...workflow.matchAll(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: ([^\n]+)/g)];
  assert.equal(checkouts.length, 3);
  for (const [, revision] of checkouts) assert.equal(revision, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.match(workflow, /run: npm run build/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: python scripts\/validate-consumer-records\.py/);
  assert.match(workflow, /run: npm run test:consumer/);
});

test('source ownership rejects renamed copies and commented private imports', t => {
  const fixture = mkdtempSync(join(tmpdir(), 'ff-ownership-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd });
  git(fixture, 'init', '-q');
  for (const path of git(root, 'ls-files', '-z').toString().split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    cpSync(join(root, path), join(fixture, path));
  }
  git(fixture, 'add', '.');
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'junction');
  const build = () => spawnSync(process.execPath, ['scripts/check-consumer.mjs'], {
    cwd: fixture, encoding: 'utf8',
  });
  assert.equal(build().status, 0, 'Disposable baseline fails');
  const blocked = (path, source, diagnostic) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), source);
    git(fixture, 'add', '--', path);
    const run = build();
    assert.equal(run.status, 1, path);
    assert.match(run.stderr, diagnostic);
    git(fixture, 'rm', '-f', '--', path);
  };
  const manifest = JSON.parse(read('docs/MIG-010-cleanup-manifest.json'));
  const atAdoption = path => git(root, 'show', manifest.adoptionCommit + ':' + path);
  blocked('src/product/copied-lifecycle.ts', atAdoption('src/lifecycle/state-machine.ts'), /relocate a copy/);
  blocked('scripts/vendor/copied-task.schema.json', atAdoption('schemas/v1/task.schema.json'), /relocate a copy/);
  for (const specifier of ['@brain-crumbs/vibez/dist/public/index.js', '../node_modules/@brain-crumbs/vibez/dist/public/index.js']) {
    blocked('scripts/private-import.mjs', 'import(/* legitimately lazy */ ' + JSON.stringify(specifier) + ');\n',
      /Unsupported Vibez package import/);
  }
  const file = join(fixture, 'migration/plan.json');
  const plan = JSON.parse(read('migration/plan.json'));
  plan.tasks.find(task => task.taskId === 'MIG-009').prerequisites = [];
  writeFileSync(file, JSON.stringify(plan));
  const missingPrerequisite = build();
  assert.equal(missingPrerequisite.status, 1);
  assert.match(missingPrerequisite.stderr, /Dropped\/changed prerequisites for MIG-009/);
});
