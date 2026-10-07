import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileEvidenceStore, validationEvidenceLineageId } from "../dist/evidence-store/index.js";
import { createLocalStatusDependencies, readLocalLifecycleStates } from "../dist/status-reporting/local-source.js";
import { renderProjectStatus } from "../dist/status-reporting/index.js";
import { runCli } from "../dist/cli/core.js";

const repositoryRoot = process.cwd();
const occurredAt = "2026-10-07T12:00:00Z";
const task = Object.freeze({
  schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: "BOOT-030", title: "Status reporting",
  objective: "Read status", inScope: ["status"], outOfScope: ["writes"], dependencies: [],
  canonicalBranch: "bootstrap/boot-030-status-reporting", allowedPaths: ["src/status-reporting/**"],
  requirements: ["BOOT-030-R1"], acceptanceCriteria: ["read status"], validationPlan: ["test"],
  affectedContracts: ["control-plane.status-reporting"], requiredReviewRoles: ["Developer", "QA"],
  sourcePath: "tasks/definitions/boot-030.task.json",
});
const registry = new Map([[task.taskId, task]]);

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}
async function withRepository(fn, { initializeGit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-status-source-"));
  try {
    cpSync(join(repositoryRoot, "schemas"), join(root, "schemas"), { recursive: true });
    if (initializeGit) {
      git(root, "init", "-b", "main");
      git(root, "config", "user.name", "Status tests");
      git(root, "config", "user.email", "status-tests@example.invalid");
      git(root, "commit", "--allow-empty", "-m", "Initial test revision");
    }
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function writeState(root, area, filename, value) {
  const directory = join(root, ".agent/state", area);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}
function lifecycle(overrides = {}) {
  return { schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId: task.taskId,
    currentState: "PLANNED", history: [], ...overrides };
}
function assignment(overrides = {}) {
  return { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId: task.taskId,
    canonicalBranch: task.canonicalBranch, lockId: "lock-1", ownerId: "developer", runId: "run-1",
    status: "ACTIVE", acquiredAt: occurredAt, ...overrides };
}
function validation(overrides = {}) {
  return { schemaId: "ipt.validation-evidence", schemaVersion: "1.0.0", taskId: task.taskId,
    evidenceId: "validation-1", revisionIdentity: "sha-1", validatorId: "test", outcome: "PASS",
    recordedAt: occurredAt, checks: [{ checkId: "tests", outcome: "PASS" }], ...overrides };
}
function evidenceFile(root) {
  const evidenceRoot = join(root, ".agent/state/evidence");
  const directory = readdirSync(evidenceRoot)[0];
  return join(evidenceRoot, directory, "0000001.json");
}

test("local readers and read-only evidence store do not create absent state directories", async () => {
  await withRepository(async root => {
    const sources = await createLocalStatusDependencies(root, registry);
    assert.equal(sources.lifecycle.get(task.taskId), null);
    assert.equal(sources.assignments.get(task.taskId), null);
    assert.equal(sources.revisions.get(task), null);
    assert.deepEqual(sources.validationLineages.list(task.taskId), []);
    assert.deepEqual(sources.evidence.getHistory(`${task.taskId}::role::QA`), []);
    assert.deepEqual(readLocalLifecycleStates(root, registry), new Map());
    const store = new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root, readOnly: true });
    assert.deepEqual(store.getHistory(validationEvidenceLineageId(task.taskId, "test")), []);
    assert.equal(store.validate(validation()).ok, true);
    assert.throws(() => store.record(validation()), /read-only/);
    assert.throws(() => store.record(null), /read-only/);
    assert.equal(existsSync(join(root, ".agent")), false);
  });
});

test("default evidence store behavior still creates directories and writes", async () => {
  await withRepository(async root => {
    const store = new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root });
    assert.equal(store.record(validation()).ok, true);
    const path = evidenceFile(root);
    const before = readFileSync(path, "utf8");
    const reader = new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root, readOnly: true });
    assert.equal(reader.getHistory(validationEvidenceLineageId(task.taskId, "test")).length, 1);
    assert.throws(() => reader.record(validation()), /read-only/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(join(path, "..")), ["0000001.json"]);
  });
});

test("omitting the registry loads the authoritative task definitions read-only", async () => {
  await withRepository(async root => {
    const definitions = join(root, "tasks/definitions");
    mkdirSync(definitions, { recursive: true });
    const definition = { ...task }; delete definition.sourcePath;
    writeFileSync(join(definitions, "boot-030.task.json"), JSON.stringify(definition));
    const sources = await createLocalStatusDependencies(root);
    assert.equal(sources.registry.get(task.taskId).canonicalBranch, task.canonicalBranch);
    assert.equal(existsSync(join(root, ".agent")), false);
  });
});

test("revision lookup uses the exact canonical local branch, without checkout or remote/tag fallback", async () => {
  await withRepository(async root => {
    const original = git(root, "rev-parse", "HEAD");
    git(root, "branch", task.canonicalBranch);
    git(root, "commit", "--allow-empty", "-m", "Different current HEAD");
    const current = git(root, "rev-parse", "HEAD");
    const missing = { ...task, taskId: "BOOT-031", canonicalBranch: "bootstrap/boot-031-missing" };
    git(root, "tag", missing.canonicalBranch);
    git(root, "tag", `refs/heads/${missing.canonicalBranch}`);
    git(root, "update-ref", `refs/remotes/origin/${missing.canonicalBranch}`, current);
    const sources = await createLocalStatusDependencies(root, new Map([...registry, [missing.taskId, missing]]));
    assert.equal(sources.revisions.get(task), original);
    assert.equal(sources.revisions.get(missing), null);
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(root, "rev-parse", "HEAD"), current);
    assert.equal(existsSync(join(root, ".agent")), false);
    git(root, "update-ref", `refs/heads/${task.canonicalBranch}`, current);
    assert.equal(sources.revisions.get(task), current, "reads stay live for double-capture change detection");
    assert.throws(() => sources.revisions.get({ ...task, canonicalBranch: "main^{commit}" }));
  });
});

test("Git errors other than an absent branch fail instead of reporting unknown revision", async () => {
  await withRepository(async root => {
    const sources = await createLocalStatusDependencies(root, registry);
    assert.throws(() => sources.revisions.get(task), /git (show-ref|rev-parse)/);
  }, { initializeGit: false });
});

test("a corrupt canonical branch ref fails instead of being classified as missing", async () => {
  await withRepository(async root => {
    const directory = join(root, ".git/refs/heads/bootstrap");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "boot-030-status-reporting"), "invalid-ref\n");
    const sources = await createLocalStatusDependencies(root, registry);
    assert.throws(() => sources.revisions.get(task), /git (show-ref|rev-parse)/);
    git(root, "tag", `refs/heads/${task.canonicalBranch}`);
    assert.throws(() => sources.revisions.get(task), /git (show-ref|rev-parse)/, "fallback tags cannot hide broken-ref diagnostics");
  });
});

test("local readers preserve authored legacy records and missing provenance fields", async () => {
  await withRepository(async root => {
    const oldState = lifecycle({ schemaVersion: "1.0.0", currentState: "READY", history: [
      { eventId: "ready-1", fromState: null, toState: "READY", occurredAt, reason: "Dependencies satisfied" },
    ] });
    const oldLock = assignment({ schemaVersion: "1.0.0" });
    delete oldLock.runId;
    const statePath = writeState(root, "lifecycle", `${task.taskId}.lifecycle.json`, oldState);
    const lockPath = writeState(root, "assignments", `${task.taskId}.lock.json`, oldLock);
    const sources = await createLocalStatusDependencies(root, registry);
    assert.deepEqual(sources.lifecycle.get(task.taskId), oldState);
    assert.deepEqual(sources.assignments.get(task.taskId), oldLock);
    assert.equal(sources.lifecycle.get(task.taskId).history[0].evidenceRef, undefined);
    assert.equal(sources.assignments.get(task.taskId).runId, undefined);
    assert.deepEqual(readLocalLifecycleStates(root, registry), new Map([[task.taskId, "READY"]]));
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), oldState);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), oldLock);
    writeState(root, "lifecycle", `${task.taskId}.lifecycle.json`, lifecycle());
    assert.equal(sources.lifecycle.get(task.taskId).currentState, "PLANNED", "lifecycle reads are live");
  });
});

test("canonical branch mismatches remain visible as assignment data for status blockers", async () => {
  await withRepository(async root => {
    const lock = assignment({ canonicalBranch: "bootstrap/wrong-task" });
    writeState(root, "assignments", `${task.taskId}.lock.json`, lock);
    const sources = await createLocalStatusDependencies(root, registry);
    assert.deepEqual(sources.assignments.get(task.taskId), lock);
  });
});

test("persisted timestamp validation accepts valid offset leap seconds and rejects invalid calendar components", async () => {
  await withRepository(async root => {
    const sources = await createLocalStatusDependencies(root, registry);
    const lock = assignment({ acquiredAt: "1990-12-31T15:59:60.123456789-08:00" });
    writeState(root, "assignments", `${task.taskId}.lock.json`, lock);
    assert.deepEqual(sources.assignments.get(task.taskId), lock);
    for (const invalid of ["2026-02-30T12:00:00Z", "2026-10-07T12:00:60Z", "2026-10-07T24:00:00Z", "2026-10-07T12:00:00+24:00"]) {
      writeState(root, "assignments", `${task.taskId}.lock.json`, assignment({ acquiredAt: invalid }));
      assert.throws(() => sources.assignments.get(task.taskId), /calendar|clock|leap-second/);
    }
  });
});

test("malformed lifecycle schema, shape, identity and history fail closed", async () => {
  await withRepository(async root => {
    const sources = await createLocalStatusDependencies(root, registry);
    const event = { eventId: "event-1", taskId: task.taskId, fromState: "PLANNED", toState: "READY", occurredAt, reason: "Ready" };
    const invalid = [null, [], lifecycle({ schemaId: "wrong" }), lifecycle({ schemaVersion: "2.0.0" }),
      lifecycle({ schemaVersion: ["1.1.0"] }), lifecycle({ taskId: "BOOT-031" }), lifecycle({ unknown: true }),
      lifecycle({ currentState: "FINISHED" }), lifecycle({ history: {} }),
      lifecycle({ currentState: "READY", history: [{ ...event, taskId: "BOOT-031" }] }),
      lifecycle({ history: [{ ...event }] }), lifecycle({ currentState: "READY", history: [{ ...event }, { ...event }] }),
      lifecycle({ currentState: "ASSIGNED", history: [event, { ...event, eventId: "event-2", fromState: "PLANNED", toState: "ASSIGNED" }] }),
      lifecycle({ currentState: "READY", history: [{ ...event, evidenceRef: 12 }] }),
      lifecycle({ currentState: "READY", history: [{ ...event, occurredAt: "2026-02-30T00:00:00Z" }] }),
    ];
    for (const raw of invalid) {
      writeState(root, "lifecycle", `${task.taskId}.lifecycle.json`, raw);
      assert.throws(() => sources.lifecycle.get(task.taskId), undefined, JSON.stringify(raw));
      assert.throws(() => readLocalLifecycleStates(root, registry), undefined, JSON.stringify(raw));
    }
    const path = writeState(root, "lifecycle", `${task.taskId}.lifecycle.json`, lifecycle());
    writeFileSync(path, "{truncated");
    assert.throws(() => sources.lifecycle.get(task.taskId), SyntaxError);
  });
});

test("malformed assignment schema, shape and identity fail closed", async () => {
  await withRepository(async root => {
    const sources = await createLocalStatusDependencies(root, registry);
    const missingRun = assignment(); delete missingRun.runId;
    for (const raw of [null, assignment({ schemaId: "wrong" }), assignment({ schemaVersion: "9.0.0" }),
      assignment({ taskId: "BOOT-031" }), assignment({ status: "PASS" }), assignment({ status: ["ACTIVE"] }),
      assignment({ ownerId: 5 }), assignment({ expiresAt: null }), assignment({ unexpected: true }), missingRun]) {
      writeState(root, "assignments", `${task.taskId}.lock.json`, raw);
      assert.throws(() => sources.assignments.get(task.taskId), undefined, JSON.stringify(raw));
    }
  });
});

test("evidence discovery preserves escaped lineages and validated append-only histories without writes", async () => {
  await withRepository(async root => {
    const evidenceRoot = join(root, ".agent/state/evidence");
    const writer = new FileEvidenceStore(evidenceRoot, { repositoryRoot: root });
    const validators = ["test/path", "test_002fpath", "unicode-😀", "test::nested"];
    for (const validatorId of validators) assert.equal(writer.record(validation({ validatorId })).ok, true);
    assert.equal(writer.record(validation({ validatorId: validators[0], evidenceId: "validation-2", outcome: "FAIL" })).ok, true);
    const sources = await createLocalStatusDependencies(root, registry);
    const lineages = sources.validationLineages.list(task.taskId);
    assert.deepEqual(lineages, validators.map(id => validationEvidenceLineageId(task.taskId, id)).sort());
    for (const lineage of lineages) assert.deepEqual(sources.evidence.getHistory(lineage), writer.getHistory(lineage));
    const history = sources.evidence.getHistory(validationEvidenceLineageId(task.taskId, validators[0]));
    assert.deepEqual(history.map(record => record.status), ["SUPERSEDED", "CURRENT"]);
    assert.equal(Object.isFrozen(history[0].payload.checks), true);
    assert.equal(writer.record(validation({ validatorId: "later" })).ok, true);
    assert.equal(sources.validationLineages.list(task.taskId).length, validators.length + 1, "lineage discovery stays live");
  });
});

test("evidence envelope and payload corruption cannot be hidden by forged task identity", async () => {
  await withRepository(async root => {
    const writer = new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root });
    writer.record(validation());
    const path = evidenceFile(root);
    const original = JSON.parse(readFileSync(path, "utf8"));
    const sources = await createLocalStatusDependencies(root, registry);
    const lineage = validationEvidenceLineageId(task.taskId, "test");
    for (const raw of [null, { ...original, lineageId: "BOOT-031::validator::test" },
      { ...original, sequence: 2 }, { ...original, storedAt: "bad-date" }, { ...original, status: "CURRENT" },
      { ...original, payload: { ...original.payload, taskId: "BOOT-031" } },
      { ...original, payload: { ...original.payload, validatorId: "different" } },
      { ...original, payload: { ...original.payload, outcome: "APPROVED" } },
      { ...original, payload: { ...original.payload, checks: [] } }]) {
      writeFileSync(path, JSON.stringify(raw));
      assert.throws(() => sources.validationLineages.list(task.taskId), undefined, JSON.stringify(raw));
      assert.throws(() => sources.evidence.getHistory(lineage), undefined, JSON.stringify(raw));
    }
    writeFileSync(path, "{partial");
    assert.throws(() => sources.validationLineages.list(task.taskId), SyntaxError);
  });
});

test("malformed evidence filenames, directory aliases and sequence holes fail closed", async () => {
  await withRepository(async root => {
    const rootPath = join(root, ".agent/state/evidence");
    const writer = new FileEvidenceStore(rootPath, { repositoryRoot: root });
    writer.record(validation());
    const path = evidenceFile(root);
    const sources = await createLocalStatusDependencies(root, registry);
    const invalidName = join(path, "..", "unexpected.json");
    renameSync(path, invalidName);
    assert.throws(() => sources.validationLineages.list(task.taskId), /sequence filename/);
    renameSync(invalidName, path);
    renameSync(path, join(path, "..", "0000002.json"));
    assert.throws(() => sources.validationLineages.list(task.taskId), /incomplete evidence sequence/);
    rmSync(rootPath, { recursive: true });
    mkdirSync(join(rootPath, `${task.taskId}_garbage`), { recursive: true });
    assert.throws(() => sources.validationLineages.list(task.taskId), /Invalid encoded evidence/);
  });
});

test("registered-task malformed review evidence is validated even when its payload claims another task", async () => {
  await withRepository(async root => {
    const reviewDirectory = join(root, ".agent/state/evidence", `${task.taskId}_003a_003arole_003a_003aQA`);
    mkdirSync(reviewDirectory, { recursive: true });
    writeFileSync(join(reviewDirectory, "0000001.json"), JSON.stringify({
      lineageId: "BOOT-999::role::QA", sequence: 1, storedAt: occurredAt, payload: { taskId: "BOOT-999" },
    }));
    const sources = await createLocalStatusDependencies(root, registry);
    assert.throws(() => sources.validationLineages.list(task.taskId), /identity mismatch/);
  });
});

test("unregistered task evidence does not expand the local task registry", async () => {
  await withRepository(async root => {
    const directory = join(root, ".agent/state/evidence", "BOOT-999_003a_003avalidator_003a_003atest");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "0000001.json"), "{unregistered malformed record");
    const sources = await createLocalStatusDependencies(root, registry);
    assert.deepEqual(sources.validationLineages.list(task.taskId), []);
    assert.deepEqual([...sources.registry.keys()], [task.taskId]);
  });
});

test("persisted reads leave lifecycle, evidence, lock and recovery files unchanged", async () => {
  await withRepository(async root => {
    git(root, "branch", task.canonicalBranch);
    writeState(root, "lifecycle", `${task.taskId}.lifecycle.json`, lifecycle({ currentState: "IN_DEVELOPMENT" }));
    writeState(root, "assignments", `${task.taskId}.lock.json`, assignment());
    writeState(root, "assignments", `${task.taskId}.lock.json.release-claim`, { interrupted: true });
    writeState(root, "assignments", `${task.taskId}.lock.json.acquire-rollback-claim`, assignment());
    const writer = new FileEvidenceStore(join(root, ".agent/state/evidence"), { repositoryRoot: root });
    writer.record(validation());
    const snapshot = path => Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(path, entry.name)) : readFileSync(join(path, entry.name), "utf8")]));
    const before = snapshot(join(root, ".agent"));
    const sources = await createLocalStatusDependencies(root, registry);
    for (let observation = 0; observation < 2; observation += 1) {
      sources.lifecycle.get(task.taskId);
      sources.assignments.get(task.taskId);
      sources.revisions.get(task);
      for (const lineage of sources.validationLineages.list(task.taskId)) sources.evidence.getHistory(lineage);
      readLocalLifecycleStates(root, registry);
    }
    assert.deepEqual(snapshot(join(root, ".agent")), before);
  });
});

test("default CLI status and next agree on persisted state while explicit next state injection is preserved", async () => {
  await withRepository(async root => {
    const nextTask = { ...task, taskId: "BOOT-031", title: "Next task", canonicalBranch: "bootstrap/boot-031-next",
      dependencies: [task.taskId], requirements: ["BOOT-031-R1"] };
    const definitions = join(root, "tasks/definitions");
    mkdirSync(definitions, { recursive: true });
    for (const current of [task, nextTask]) {
      const definition = { ...current }; delete definition.sourcePath;
      writeFileSync(join(definitions, `${current.taskId.toLowerCase()}.task.json`), JSON.stringify(definition));
      git(root, "branch", current.canonicalBranch);
    }
    writeState(root, "lifecycle", `${task.taskId}.lifecycle.json`, lifecycle({ currentState: "DONE" }));
    const context = { repositoryRoot: root, now: () => occurredAt };
    const jsonStatus = await runCli(["status", "--json"], context);
    const jsonNext = await runCli(["next", "--json"], context);
    const humanStatus = await runCli(["status"], context);
    assert.equal(jsonStatus.exitCode, 0, jsonStatus.stderr || jsonStatus.stdout);
    assert.equal(jsonNext.exitCode, 0, jsonNext.stderr || jsonNext.stdout);
    assert.equal(humanStatus.exitCode, 0, humanStatus.stderr);
    const status = JSON.parse(jsonStatus.stdout).data;
    const next = JSON.parse(jsonNext.stdout).data;
    assert.equal(status.tasks[0].state, "DONE");
    assert.equal(status.tasks[0].stateSource, "PERSISTED");
    assert.equal(status.next.taskId, nextTask.taskId);
    assert.deepEqual(next, status.next);
    assert.equal(humanStatus.stdout, `${renderProjectStatus(status)}\n`);
    const injected = await runCli(["next", "--json"], { ...context, taskStates: new Map() });
    assert.equal(injected.exitCode, 0);
    assert.equal(JSON.parse(injected.stdout).data.taskId, task.taskId, "an explicit map overrides persisted states");
  });
});
