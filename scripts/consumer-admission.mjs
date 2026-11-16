import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const taskId = 'MIG-009';
const taskPath = 'tasks/admitted/mig-009.task.json';
const requirementPath = 'requirements/migration/mig-009.requirement.json';
const receiptPath = 'migration/admissions/mig-009.json';
const configPath = 'vibez.config.json';

export async function verifyConsumerAdmission(root) {
  const read = path => readFile(join(root, path));
  const json = async path => JSON.parse(await read(path));
  const config = await json(configPath);
  assert.equal(config.paths.tasks, 'tasks/admitted');
  const definitions = (await readdir(join(root, config.paths.tasks))).filter(name => name.endsWith('.task.json'));
  assert.deepEqual(definitions, ['mig-009.task.json']);
  const receipt = await json(receiptPath);
  assert.equal(receipt.taskId, taskId);
  assert.equal(receipt.repository, config.project.repository);
  assert.equal(receipt.issue, 'https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/81');
  assert.deepEqual(receipt.dependencyProjection, { native: [], external: ['MIG-008'] });
  for (const [expected, input] of [[taskPath, receipt.definition], [requirementPath, receipt.requirement]]) {
    assert.equal(input.path, expected);
    assert.equal(createHash('sha256').update(await read(expected)).digest('hex'), input.sha256, expected);
  }
  assert.equal((await json(taskPath)).taskId, taskId);
  assert.deepEqual((await json(taskPath)).dependencies, []);
  assert.equal((await json(requirementPath)).sourceRefs[1], `sha256:${receipt.issueBodySha256}`);
}
