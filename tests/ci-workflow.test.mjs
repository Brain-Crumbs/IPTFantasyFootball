import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
const workflowText = readFileSync(workflowPath, "utf8");

// BOOT-023 acceptance criterion: "Workflow uses pinned/appropriately versioned
// actions/toolchain per project policy." No YAML dependency exists in
// package.json, so this asserts on the raw workflow text rather than
// introducing a new parsing dependency, matching this repository's
// no-new-dependency convention for tests.
test("CI workflow declares both required jobs with documented check names", () => {
  assert.match(workflowText, /\n {2}build-and-test:\n/);
  assert.match(workflowText, /name: Build and test \(Node\)/);
  assert.match(workflowText, /\n {2}schema-validation:\n/);
  assert.match(workflowText, /name: Schema and contract validation \(Python\)/);
});

test("CI workflow triggers on pull_request and push to main, plus manual dispatch", () => {
  assert.match(workflowText, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflowText, /push:\n\s+branches: \[main\]/);
  assert.match(workflowText, /workflow_dispatch: \{\}/);
});

test("CI workflow cancels a stale in-flight run for the same ref", () => {
  assert.match(workflowText, /concurrency:/);
  assert.match(workflowText, /cancel-in-progress: true/);
});

test("CI workflow pins actions to exact major versions, not floating refs", () => {
  const actionUses = [...workflowText.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(actionUses.length > 0, "expected at least one `uses:` step");
  for (const use of actionUses) {
    assert.match(
      use,
      /^actions\/(checkout|setup-node|setup-python)@v\d+$/,
      `${use} must be pinned to an exact major-version tag`,
    );
  }
});

test("build-and-test job reruns the repository's own build and full test suite", () => {
  assert.match(workflowText, /run: npm ci/);
  assert.match(workflowText, /run: npm run build/);
  assert.match(workflowText, /run: npm test/);
});

test("schema-validation job reruns fixture validation and real-record validation", () => {
  assert.match(workflowText, /run: python schemas\/validate_fixtures\.py/);
  assert.match(workflowText, /run: python schemas\/validate_repository_contracts\.py/);
});

function runInvariantScript(cwd) {
  try {
    const stdout = execFileSync("python3", [join(cwd, "schemas", "validate_repository_contracts.py")], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("validate_repository_contracts.py passes against this repository's real records", () => {
  const result = runInvariantScript(repoRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS: \d+ repository contract\/task record\(s\) validated against their schema/m);
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ipt-ci-invariant-"));
  cpSync(join(repoRoot, "schemas"), join(dir, "schemas"), { recursive: true });
  cpSync(join(repoRoot, "contracts"), join(dir, "contracts"), { recursive: true });
  mkdirSync(join(dir, "tasks", "definitions"), { recursive: true });
  return dir;
}

test("validate_repository_contracts.py fails when a real module-contract.json is invalid", () => {
  const dir = sandbox();
  try {
    const target = join(dir, "contracts", "pr-lifecycle", "module-contract.json");
    const contract = JSON.parse(readFileSync(target, "utf8"));
    delete contract.knownConsumers;
    writeFileSync(target, JSON.stringify(contract, null, 2));

    const result = runInvariantScript(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL: contracts[\\/]pr-lifecycle[\\/]module-contract\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate_repository_contracts.py fails on malformed JSON rather than crashing", () => {
  const dir = sandbox();
  try {
    const target = join(dir, "contracts", "pr-lifecycle", "module-contract.json");
    writeFileSync(target, "{ not valid json");

    const result = runInvariantScript(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL: contracts[\\/]pr-lifecycle[\\/]module-contract\.json: invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate_repository_contracts.py fails rather than vacuously passing when no module-contract.json exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "ipt-ci-invariant-empty-"));
  try {
    cpSync(join(repoRoot, "schemas"), join(dir, "schemas"), { recursive: true });
    mkdirSync(join(dir, "contracts"), { recursive: true });
    mkdirSync(join(dir, "tasks", "definitions"), { recursive: true });

    const result = runInvariantScript(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAIL: module-contract: expected at least one file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
