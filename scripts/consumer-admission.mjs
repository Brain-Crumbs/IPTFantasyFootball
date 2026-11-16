import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const activeMigration = Object.freeze({ taskId: 'MIG-010', issueNumber: 82 });
const admissions = [
  { ...activeMigration, native: ['MIG-009'], external: [] },
  { taskId: 'MIG-009', issueNumber: 81, native: [], external: ['MIG-008'] },
];

export async function verifyConsumerAdmission(root) {
  const read = path => readFile(join(root, path));
  const json = async path => JSON.parse(await read(path));
  const config = await json('vibez.config.json');
  assert.equal(config.paths.tasks, 'tasks/admitted');
  const definitions = (await readdir(join(root, config.paths.tasks))).filter(name => name.endsWith('.task.json'));
  assert.deepEqual(definitions.sort(), admissions.map(({ taskId }) => taskId.toLowerCase() + '.task.json').sort());
  for (const { taskId, issueNumber, native, external } of admissions) {
    const stem = taskId.toLowerCase();
    const taskPath = `tasks/admitted/${stem}.task.json`;
    const requirementPath = `requirements/migration/${stem}.requirement.json`;
    const receipt = await json(`migration/admissions/${stem}.json`);
    assert.equal(receipt.taskId, taskId);
    assert.equal(receipt.repository, config.project.repository);
    assert.equal(receipt.issue, `https://github.com/${config.project.repository}/issues/${issueNumber}`);
    assert.deepEqual(receipt.dependencyProjection, { native, external });
    for (const [expected, input] of [[taskPath, receipt.definition], [requirementPath, receipt.requirement]]) {
      assert.equal(input.path, expected);
      assert.equal(createHash('sha256').update(await read(expected)).digest('hex'), input.sha256, expected);
    }
    const task = await json(taskPath);
    const requirement = await json(requirementPath);
    assert.equal(task.taskId, taskId);
    assert.equal(task.canonicalBranch, receipt.canonicalBranch);
    assert.deepEqual(task.dependencies, native);
    assert.deepEqual(task.requirements, [requirement.requirementId]);
    assert.deepEqual(task.acceptanceCriteria, requirement.acceptanceCriteria);
    assert.deepEqual(requirement.sourceRefs, [receipt.issue, `sha256:${receipt.issueBodySha256}`]);
  }
}

export function prepareAdmittedPublication(payload, method) {
  const closingLines = payload.body?.match(/^Closes #\d+\s*$/gm)?.map(line => line.trim());
  assert.ok(closingLines?.length && closingLines.every(line => line === `Closes #${activeMigration.issueNumber}`),
    `Publication must close the admitted Fantasy Football issue #${activeMigration.issueNumber}.`);
  const coordination = 'Coordinates Fantasy Football #1 and #74, and Brain-Crumbs/Vibez#1.';
  const body = payload.body.split(/\r?\n/).includes(coordination)
    ? payload.body
    : payload.body.trimEnd() + '\n\n' + coordination + '\n';
  return { ...payload, body, ...(method === 'POST' ? { draft: true } : {}) };
}
