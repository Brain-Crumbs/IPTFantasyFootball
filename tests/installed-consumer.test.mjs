import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { describeCapabilities } from '@brain-crumbs/vibez';
import { readContract } from '@brain-crumbs/vibez/assets';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = 'https://github.com/Brain-Crumbs/Vibez/releases/download/v0.1.0-rc.1/brain-crumbs-vibez-0.1.0-rc.1.tgz';
const integrity = 'sha512-+ILl/hLZ+57upOvVAlkxAGZbI2LUW5my8ok37jVUF4cXF+uU/CK6YssJlfBNo/ZfLDCa2dlKFqUvTJAvciTqzA==';
const version = '0.1.0-rc.1';

test('the consumer and its admission receipt pin the published release', () => {
  const read = relative => readFileSync(join(root, relative));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.dependencies['@brain-crumbs/vibez'], pin);
  assert.equal(pkg.scripts.agent, 'node scripts/agent.mjs');
  assert.equal(pkg.scripts.preagent, undefined);
  assert.equal(pkg.bin, undefined);
  const locked = lock.packages['node_modules/@brain-crumbs/vibez'];
  assert.equal(locked.resolved, pin);
  assert.equal(locked.integrity, integrity);
  assert.equal(locked.version, version);
  describeCapabilities({ apiVersion: '1.0.0', packageVersion: version });

  const receipt = JSON.parse(read('migration/admissions/mig-009.json'));
  for (const input of [receipt.definition, receipt.requirement]) {
    assert.equal(createHash('sha256').update(read(input.path)).digest('hex'), input.sha256, input.path);
  }
  const task = JSON.parse(read(receipt.definition.path));
  assert.deepEqual(task.dependencies, []);
  assert.deepEqual(receipt.dependencyProjection.external, ['MIG-008']);
  const contractVersions = {
    'control-plane.orchestration-engine': '2.2.0',
    'control-plane.recovery-tools': '1.1.0',
  };
  for (const id of task.affectedContracts) {
    const { document, sha256 } = readContract(id);
    assert.equal(document.moduleId, id);
    assert.equal(document.moduleVersion, contractVersions[id]);
    assert.match(sha256, /^[a-f0-9]{64}$/);
  }
});

test('configured installed operator uses only the admitted registry and separate runtime', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fantasy football consumer '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, 'project checkout');
  mkdirSync(checkout);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/Brain-Crumbs/IPTFantasyFootball.git');
  for (const path of ['.gitignore', 'vibez.config.json', 'tasks', 'requirements', 'contracts/project', 'scripts/agent.mjs', 'scripts/consumer-admission.mjs', 'migration/admissions']) {
    cpSync(join(root, path), join(checkout, path), { recursive: true });
  }
  git('add', '--all');
  git('-c', 'user.name=MIG-009 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Prepare consumer fixture');
  cpSync(join(root, 'node_modules/@brain-crumbs/vibez'), join(checkout, 'node_modules/@brain-crumbs/vibez'), { recursive: true });

  const cli = (args, { windowsAttestation = true } = {}) => {
    const storage = process.platform === 'win32' && windowsAttestation ? ['--local-ntfs'] : [];
    const result = spawnSync(process.execPath, [join(checkout, 'scripts/agent.mjs'), '--json', ...storage, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, IPT_GITHUB_TOKEN: '', GITHUB_TOKEN: '', IPT_DRIVER_MERGE: '', NODE_PATH: '' },
    });
    assert.ifError(result.error);
    assert.ok(result.stdout, result.stderr);
    return { status: result.status, ...JSON.parse(result.stdout) };
  };
  if (process.platform === 'win32') {
    assert.equal(cli(['status'], { windowsAttestation: false }).status, 4);
  }
  for (const command of [['status'], ['explain', 'task', 'MIG-009'], ['audit', 'MIG-009'], ['recovery', 'check']]) {
    const result = cli(command);
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.ok, true);
  }
  assert.equal(cli(['next']).data.taskId, 'MIG-009');
  assert.equal(existsSync(join(checkout, '.agent')), false, 'read-only commands wrote state');
  assert.equal(existsSync(join(checkout, '.git/vibez-project.json')), false, 'read-only commands claimed the store');
  const init = cli(['orchestrate', 'init', '--actor-prefix', 'fixture', '--developer-tools', 'read_file,write_file,git_commit',
    '--review-tools', 'read_file,run_test', '--enforce-policies', 'externally']);
  assert.equal(init.status, 0, JSON.stringify(init));
  assert.ok(existsSync(join(checkout, '.agent/vibez/operations/driver/profile.json')));
  assert.equal(cli(['orchestrate', 'select', 'MIG-009', '--issue-number', '78']).error.code, 'ADMISSION_ISSUE_MISMATCH');
  const select = cli(['orchestrate', 'select', 'MIG-009', '--issue-number', '81']);
  assert.equal(select.status, 0, JSON.stringify(select));
  assert.equal(select.data.status, 'PREPARED');
  assert.equal(cli(['orchestrate', 'prepare']).error.code, 'REVIEWED_ADMISSION_REQUIRED');
  const issueInbox = join(checkout, '.agent/vibez/inbox/issues');
  mkdirSync(issueInbox, { recursive: true });
  writeFileSync(join(issueInbox, 'unexpected.md'), 'Unreviewed intake');
  assert.equal(cli(['orchestrate', 'run', select.data.sessionId]).status, 4);
  assert.equal(existsSync(join(checkout, '.agent/vibez/state/lifecycle/MIG-009.lifecycle.json')), false);

  assert.equal(existsSync(join(checkout, '.agent/state')), false);
  assert.equal(existsSync(join(checkout, 'dist')), false);
  assert.equal(existsSync(join(checkout, 'schemas')), false);

  const extraDefinition = join(checkout, 'tasks/admitted/unreviewed.task.json');
  cpSync(join(checkout, 'tasks/admitted/mig-009.task.json'), extraDefinition);
  git('add', '--all');
  git('-c', 'user.name=MIG-009 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Exercise unreviewed input rejection');
  assert.equal(cli(['next']).status, 4);
});
