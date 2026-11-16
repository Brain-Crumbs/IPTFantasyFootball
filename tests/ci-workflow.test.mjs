import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
