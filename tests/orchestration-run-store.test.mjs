import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileOrchestrationRunStore, MemoryOrchestrationRunStore, RunStoreError } from "../dist/orchestration-engine/index.js";

const moduleUrl = new URL("../dist/orchestration-engine/index.js", import.meta.url).href;
const occurredAt = "2026-10-07T20:00:00Z";
const revision = "1234567890123456789012345678901234567890";
function journal(overrides = {}) {
  return { schemaVersion: 1, idempotencyKey: "key-1", ownerId: "owner-1", runId: "run-1", occurredAt, values: {}, attempts: {}, ...overrides };
}
function checkpoint() {
  const value = journal({ attempts: { "developer-agent": 1 } });
  value.values.start = {
    kind: "started", taskId: "BOOT-900", title: "Store fixture", canonicalBranch: "bootstrap/boot-900-fixture", sourceRevision: revision,
    lifecycleState: "IN_DEVELOPMENT", branchCreated: true,
    assignment: { ownerId: "owner-1", runId: "run-1::developer-start", lockId: "lock-1" },
    acceptanceCriteria: [], contextLocation: "inline", nextInstructions: [],
    context: { schemaVersion: "1.0.0", taskId: "BOOT-900", role: "Developer", sourceRevision: revision,
      task: {}, artifacts: [], manifest: { included: [], excluded: [] } },
  };
  value.values["developer-agent"] = {
    contextId: "context-1", actorId: "owner-1",
    result: { runId: "run-1::developer-agent", providerId: "fixture-provider", taskId: "BOOT-900", role: "Developer",
      revisionIdentity: revision, outcome: "PASS", details: {}, findings: [], evidenceRefs: [], occurredAt },
  };
  return value;
}
function code(expected) {
  return error => error instanceof RunStoreError && error.code === expected;
}
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "ipt-orchestration-run-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function filePath(root, key = "key-1") {
  return join(root, `${createHash("sha256").update(key).digest("hex")}.run.json`);
}

for (const adapter of ["memory", "file"]) {
  function store(t) { return adapter === "memory" ? new MemoryOrchestrationRunStore() : new FileOrchestrationRunStore(directory(t)); }

  test(`${adapter}: journal reads and writes detach caller-owned nested objects`, async t => {
    const subject = store(t);
    const first = journal();
    assert.equal(subject.get("missing"), null);
    await subject.withLock(async () => subject.save(first));
    first.attempts["qa-agent"] = 9;
    const read = subject.get("key-1");
    assert.deepEqual(read.attempts, {});
    read.attempts["qa-agent"] = 7;
    assert.deepEqual(subject.get("key-1").attempts, {});
  });

  test(`${adapter}: only the async lock owner may save, including across awaits`, async t => {
    const subject = store(t);
    assert.throws(() => subject.save(journal()), code("STATE_CONFLICT"));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const active = subject.withLock(async () => { await gate; subject.save(journal()); });
    assert.throws(() => subject.save(journal()), code("STATE_CONFLICT"));
    await assert.rejects(() => subject.withLock(async () => {}), code("RUN_ACTIVE"));
    release();
    await active;
    assert.equal(subject.get("key-1").runId, "run-1");
  });

  test(`${adapter}: callback failures release the lock without erasing durable checkpoints`, async t => {
    const subject = store(t);
    const sentinel = new Error("provider failed");
    await assert.rejects(subject.withLock(async () => { subject.save(journal()); throw sentinel; }), error => error === sentinel);
    await subject.withLock(async () => {
      const saved = subject.get("key-1");
      saved.attempts["qa-agent"] = 1;
      subject.save(saved);
    });
    assert.equal(subject.get("key-1").attempts["qa-agent"], 1);
  });

  test(`${adapter}: run/key identity and initial occurrence cannot be rebound`, async t => {
    const subject = store(t);
    await subject.withLock(async () => {
      subject.save(journal());
      for (const override of [ { ownerId: "other" }, { runId: "other" }, { occurredAt: "2026-10-08T20:00:00Z" },
        { idempotencyKey: "key-2" }, { idempotencyKey: "key-2", ownerId: "other" } ]) {
        assert.throws(() => subject.save(journal(override)), code("IDEMPOTENCY_CONFLICT"));
      }
      subject.save(journal({ idempotencyKey: "key-2", runId: "run-2" }));
    });
    assert.equal(subject.get("key-1").ownerId, "owner-1");
  });

  test(`${adapter}: retry accounting persists monotonically and rejects erase/reset`, async t => {
    const subject = store(t);
    await subject.withLock(async () => {
      subject.save(journal({ attempts: { "qa-agent": 3 } }));
      for (const attempts of [{}, { "qa-agent": 0 }, { "qa-agent": 2 }]) {
        assert.throws(() => subject.save(journal({ attempts })), code("STATE_CONFLICT"));
      }
      subject.save(journal({ attempts: { "qa-agent": 10 } }));
    });
    assert.equal(subject.get("key-1").attempts["qa-agent"], 10);
  });

  test(`${adapter}: malformed journals are rejected without replacing a valid snapshot`, async t => {
    const subject = store(t);
    const cycle = {}; cycle.self = cycle;
    const getter = {}; Object.defineProperty(getter, "bad", { get() { throw new Error("must not execute accessor"); }, enumerable: true });
    const hidden = {}; Object.defineProperty(hidden, "hidden", { value: 1 });
    const invalid = [
      null, [], journal({ schemaVersion: 2 }), journal({ ownerId: " " }), journal({ occurredAt: "yesterday" }),
      journal({ attempts: { "qa-agent": -1 } }), journal({ attempts: { "qa-agent": 11 } }),
      journal({ attempts: { "qa-agent": 1.5 } }), journal({ attempts: { "qa-agent": "1" } }),
      journal({ attempts: { "qa-review": 1 } }), journal({ pendingStage: "unknown" }),
      journal({ lastFailure: { kind: "REVIEW_FAILED", code: "FAIL", message: "incorrect taxonomy" } }),
      journal({ unexpected: true }), journal({ values: { start: null } }), journal({ values: { stages: [{}] } }),
      journal({ values: { result: { status: "COMPLETED" } } }), journal({ values: { "qa-agent": { result: {} } } }),
      journal({ values: { unknown: true } }), journal({ values: { stages: undefined } }),
      journal({ values: { stages: [NaN] } }), journal({ values: { stages: [Infinity] } }),
      journal({ values: { stages: [new Date()] } }), journal({ values: { stages: Array(1) } }),
      journal({ values: { stages: [cycle] } }), journal({ values: { stages: [getter] } }),
      journal({ values: { stages: [hidden] } }), journal({ values: { stages: [() => {}] } }),
    ];
    await subject.withLock(async () => {
      subject.save(journal());
      for (const bad of invalid) assert.throws(() => subject.save(bad), code("INVALID_JOURNAL"));
      assert.deepEqual(subject.get("key-1"), journal());
    });
  });

  test(`${adapter}: cached provider result identities are validated and successful checkpoints are immutable`, async t => {
    const subject = store(t);
    await subject.withLock(async () => {
      subject.save(checkpoint());
      for (const part of ["start", "developer-agent"]) {
        const changed = subject.get("key-1");
        delete changed.values[part];
        assert.throws(() => subject.save(changed), error => ["STATE_CONFLICT", "INVALID_JOURNAL"].includes(error.code));
      }
      const replaced = subject.get("key-1");
      replaced.values["developer-agent"].result.details = { fabricated: "replacement" };
      assert.throws(() => subject.save(replaced), code("STATE_CONFLICT"));
      for (const changes of [{ role: "QA" }, { taskId: "BOOT-999" }, { runId: "unrelated" }, { outcome: "UNKNOWN" },
        { findings: [{ findingId: "duplicate", severity: "INFO", observed: " hi ", expected: " there " },
          { findingId: "duplicate", severity: "INFO", observed: "a", expected: "b" }] },
        { outcome: "FAIL", nonPass: {} }]) {
        const malformed = subject.get("key-1");
        Object.assign(malformed.values["developer-agent"].result, changes);
        assert.throws(() => subject.save(malformed), code("INVALID_JOURNAL"));
      }
    });
  });

  test(`${adapter}: INFO findings and whitespace-bearing finding prose preserve provider range`, async t => {
    const subject = store(t);
    const valid = checkpoint();
    valid.values["developer-agent"].result.findings = [{ findingId: "info", severity: "INFO", observed: " detail ", expected: " expectation " }];
    await subject.withLock(async () => subject.save(valid));
    assert.equal(subject.get("key-1").values["developer-agent"].result.findings[0].severity, "INFO");
  });
}

test("file: fresh instances resume pending stage, failure and cumulative retry counters", async t => {
  const root = directory(t);
  const initial = journal({ attempts: { "qa-agent": 2 }, pendingStage: "qa-agent", lastFailure: { kind: "INFRASTRUCTURE", code: "TIMEOUT", message: "provider timeout" } });
  const first = new FileOrchestrationRunStore(root);
  await first.withLock(async () => first.save(initial));
  const fresh = new FileOrchestrationRunStore(root);
  assert.deepEqual(fresh.get("key-1"), initial);
  await fresh.withLock(async () => {
    const saved = fresh.get("key-1");
    saved.attempts["qa-agent"] += 1;
    delete saved.pendingStage;
    fresh.save(saved);
  });
  assert.equal(new FileOrchestrationRunStore(root).get("key-1").attempts["qa-agent"], 3);
  assert.equal(readdirSync(root).filter(name => name.endsWith(".tmp")).length, 0);
});

test("file: unsafe-looking keys use collision-resistant filenames without path traversal", async t => {
  const root = directory(t);
  const subject = new FileOrchestrationRunStore(root);
  await subject.withLock(async () => {
    for (const [index, key] of ["../escape", "/absolute/path", "💾:/run"].entries()) {
      subject.save(journal({ idempotencyKey: key, runId: `run-${index}` }));
      assert.equal(subject.get(key).idempotencyKey, key);
    }
  });
  assert.ok(readdirSync(root).every(name => /^[a-f0-9]{64}\.run\.json$/.test(name)));
});

test("file: corrupt, unknown-version and misfiled journals fail closed and are never overwritten", async t => {
  const root = directory(t);
  const subject = new FileOrchestrationRunStore(root);
  for (const serialized of ["{partial", JSON.stringify(journal({ schemaVersion: 99 })), JSON.stringify(journal({ idempotencyKey: "other" }))]) {
    writeFileSync(filePath(root), serialized);
    assert.throws(() => subject.get("key-1"), code("INVALID_JOURNAL"));
    await assert.rejects(subject.withLock(async () => subject.save(journal())), code("INVALID_JOURNAL"));
    assert.equal(readFileSync(filePath(root), "utf8"), serialized);
  }
});

test("file: malformed neighboring journal blocks writes rather than concealing a conflicting run", async t => {
  const root = directory(t);
  const subject = new FileOrchestrationRunStore(root);
  writeFileSync(filePath(root, "other"), "{partial");
  await assert.rejects(subject.withLock(async () => subject.save(journal())), code("INVALID_JOURNAL"));
  assert.equal(subject.get("key-1"), null);
});

test("file: symlink journals are rejected and cannot redirect writes", async t => {
  const root = directory(t);
  const destination = join(directory(t), "target.json");
  writeFileSync(destination, JSON.stringify(journal()));
  symlinkSync(destination, filePath(root));
  const subject = new FileOrchestrationRunStore(root);
  assert.throws(() => subject.get("key-1"), code("INVALID_JOURNAL"));
  await assert.rejects(subject.withLock(async () => subject.save(journal())), code("INVALID_JOURNAL"));
  assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), journal());
});

test("file: interrupted temporary writes do not replace a committed checkpoint", async t => {
  const root = directory(t);
  const subject = new FileOrchestrationRunStore(root);
  await subject.withLock(async () => subject.save(journal({ attempts: { "qa-agent": 1 } })));
  writeFileSync(join(root, ".write-interrupted.tmp"), '{"attempts":');
  const fresh = new FileOrchestrationRunStore(root);
  assert.equal(fresh.get("key-1").attempts["qa-agent"], 1);
  await fresh.withLock(async () => fresh.save(fresh.get("key-1")));
  assert.ok(existsSync(join(root, ".write-interrupted.tmp")), "unknown abandoned temporaries are not silently removed");
});

test("file: repository-wide exclusion works across instances, keys and OS processes", async t => {
  const root = directory(t);
  const first = new FileOrchestrationRunStore(root);
  const second = new FileOrchestrationRunStore(root);
  await first.withLock(async () => {
    await assert.rejects(second.withLock(async () => second.save(journal({ idempotencyKey: "other", runId: "other" }))), code("RUN_ACTIVE"));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { FileOrchestrationRunStore } from ${JSON.stringify(moduleUrl)};
      try { await new FileOrchestrationRunStore(${JSON.stringify(root)}).withLock(async () => {}); process.exitCode = 2; }
      catch (error) { if (error.code !== 'RUN_ACTIVE') throw error; }
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    first.save(journal());
  });
  await second.withLock(async () => second.save(second.get("key-1")));
});

test("file: a changed ownership token fences writes and is never deleted by the former owner", async t => {
  const root = directory(t);
  const subject = new FileOrchestrationRunStore(root);
  const lock = join(root, ".orchestration.lock");
  await assert.rejects(subject.withLock(async () => {
    writeFileSync(lock, "foreign-owner");
    assert.throws(() => subject.save(journal()), code("STATE_CONFLICT"));
  }), code("STATE_CONFLICT"));
  assert.equal(readFileSync(lock, "utf8"), "foreign-owner");
  assert.equal(subject.get("key-1"), null);
});

test("file: actual child-process crash retains durable attempts and refuses unsafe lock stealing", async t => {
  const root = directory(t);
  const initial = journal({ attempts: { "qa-agent": 2 }, pendingStage: "qa-agent" });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { FileOrchestrationRunStore } from ${JSON.stringify(moduleUrl)};
    const store = new FileOrchestrationRunStore(${JSON.stringify(root)});
    await store.withLock(async () => { store.save(${JSON.stringify(initial)}); process.exit(42); });
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 42, child.stderr);
  const fresh = new FileOrchestrationRunStore(root);
  assert.deepEqual(fresh.get("key-1"), initial);
  await assert.rejects(fresh.withLock(async () => {}), code("RUN_ACTIVE"));
  // This isolated fixture has no other runners; the only owner's exit is observed.
  // Production recovery must establish the same quiescence before removing a lock.
  unlinkSync(join(root, ".orchestration.lock"));
  await fresh.withLock(async () => {
    const saved = fresh.get("key-1");
    saved.attempts["qa-agent"] += 1;
    fresh.save(saved);
  });
  assert.equal(fresh.get("key-1").attempts["qa-agent"], 3);
});

test("journal request timestamps preserve the engine RFC 3339 range and reject impossible dates", async () => {
  const subject = new MemoryOrchestrationRunStore();
  const valid = ["2026-10-07t20:00:00z", "2016-12-31T23:59:60Z", "2017-01-01T00:59:60+01:00", "2024-02-29T00:00:00Z"];
  await subject.withLock(async () => {
    for (const [index, value] of valid.entries()) {
      subject.save(journal({ idempotencyKey: `key-${index}`, runId: `run-${index}`, occurredAt: value }));
    }
    for (const value of ["2026-02-30T20:00:00Z", "2026-10-07T20:00:00", "2016-12-31T22:59:60Z", "2025-02-29T00:00:00Z"]) {
      assert.throws(() => subject.save(journal({ occurredAt: value })), code("INVALID_JOURNAL"));
    }
  });
});

test("file: a failed atomic replacement preserves the prior snapshot and removes only its own temporary", async t => {
  const root = directory(t);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { FileOrchestrationRunStore } from ${JSON.stringify(moduleUrl)};
    const store = new FileOrchestrationRunStore(${JSON.stringify(root)});
    await store.withLock(async () => {
      store.save(${JSON.stringify(journal({ attempts: { "qa-agent": 1 } }))});
      const rename = fs.renameSync;
      fs.renameSync = () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); };
      syncBuiltinESMExports();
      try {
        const next = store.get('key-1'); next.attempts['qa-agent'] = 2;
        assert.throws(() => store.save(next), error => error.code === 'STATE_IO_FAILED');
      } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
      assert.equal(store.get('key-1').attempts['qa-agent'], 1);
    });
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readdirSync(root), [filePath(root).split("/").at(-1)]);
  assert.equal(new FileOrchestrationRunStore(root).get("key-1").attempts["qa-agent"], 1);
});

test("cached Developer titles preserve the task schema minLength-only range", async () => {
  for (const title of [" Fixture title ", " ", "\t\n"]) {
    const subject = new MemoryOrchestrationRunStore();
    const valid = checkpoint();
    valid.values.start.title = title;
    await subject.withLock(async () => subject.save(valid));
    assert.equal(subject.get("key-1").values.start.title, title);
  }
  const subject = new MemoryOrchestrationRunStore();
  const invalid = checkpoint();
  invalid.values.start.title = "";
  await assert.rejects(subject.withLock(async () => subject.save(invalid)), code("INVALID_JOURNAL"));
});

test("cached provider identity retains the exact producer-supplied string without normalization", async () => {
  for (const providerId of [" vendor adapter ", "", "fixture-provider"]) {
    const subject = new MemoryOrchestrationRunStore();
    const valid = checkpoint();
    valid.values["developer-agent"].result.providerId = providerId;
    await subject.withLock(async () => subject.save(valid));
    assert.equal(subject.get("key-1").values["developer-agent"].result.providerId, providerId);
  }
});
