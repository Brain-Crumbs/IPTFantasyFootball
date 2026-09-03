import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSITION_RULES,
  createLifecycleRecord,
  transitionLifecycle,
} from "../dist/lifecycle/index.js";

const all = [
  "DEPENDENCIES_SATISFIED","ASSIGNMENT_ACTIVE","BRANCH_VERIFIED","DEV_VALIDATION_PASSED",
  "QA_REVIEW_REQUESTED","QA_PASSED","ARCHITECTURE_PASSED","UAT_PASSED","MERGE_COMPLETED",
  "COMPLETION_RECORDED","FAILURE_EVIDENCE_RECORDED","REWORK_FINDINGS_RECORDED","REWORK_STARTED","BLOCKER_RECORDED",
];

function step(record, toState, eventId) {
  const result = transitionLifecycle(record, {
    taskId: record.taskId,
    expectedState: record.currentState,
    toState,
    eventId,
    occurredAt: "2026-09-03T23:00:00.000Z",
    reason: `move to ${toState}`,
    evidenceRef: `evidence/${eventId}`,
    satisfiedPrerequisites: all,
    actorId: "agent:test",
    runId: "run:test",
    revisionIdentity: "abc123",
  });
  assert.equal(result.ok, true);
  return result.record;
}

test("happy path reaches DONE and records append-only task-bound history", () => {
  let record = createLifecycleRecord("BOOT-009");
  for (const state of ["READY","ASSIGNED","IN_DEVELOPMENT","DEV_VALIDATED","QA_REVIEW","ARCHITECTURE_REVIEW","UAT_REVIEW","MERGE_READY","MERGED","DONE"]) {
    record = step(record, state, `event-${state}`);
  }
  assert.equal(record.currentState, "DONE");
  assert.equal(record.history.length, 10);
  assert.ok(record.history.every((event) => event.taskId === "BOOT-009" && event.evidenceRef));
});

test("illegal skip and missing prerequisites reject without mutation", () => {
  const record = createLifecycleRecord("BOOT-009");
  const skip = transitionLifecycle(record, {
    taskId: "BOOT-009", expectedState: "PLANNED", toState: "IN_DEVELOPMENT", eventId: "skip",
    occurredAt: "2026-09-03T23:00:00.000Z", reason: "skip", evidenceRef: "evidence/skip", satisfiedPrerequisites: all,
  });
  assert.equal(skip.ok, false);
  assert.equal(skip.rejection.code, "ILLEGAL_TRANSITION");
  assert.strictEqual(skip.record, record);
  const missing = transitionLifecycle(record, {
    taskId: "BOOT-009", expectedState: "PLANNED", toState: "READY", eventId: "missing",
    occurredAt: "2026-09-03T23:00:00.000Z", reason: "missing", evidenceRef: "evidence/missing",
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.rejection.missingPrerequisites, ["DEPENDENCIES_SATISFIED"]);
  assert.strictEqual(missing.record, record);
});

test("stale expected state rejects without mutation", () => {
  const planned = createLifecycleRecord("BOOT-009");
  const ready = step(planned, "READY", "ready");
  const stale = transitionLifecycle(ready, {
    taskId: "BOOT-009", expectedState: "PLANNED", toState: "ASSIGNED", eventId: "stale",
    occurredAt: "2026-09-03T23:00:00.000Z", reason: "stale", evidenceRef: "evidence/stale", satisfiedPrerequisites: all,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.rejection.code, "STALE_EXPECTED_STATE");
  assert.strictEqual(stale.record, ready);
});

test("QA, architecture, and UAT failures return through REWORK_REQUIRED to development preserving history", () => {
  for (const failure of ["QA_FAILED", "ARCHITECTURE_FAILED", "UAT_FAILED"]) {
    let record = createLifecycleRecord("BOOT-009");
    record = step(record, "READY", `${failure}-ready`);
    record = step(record, "ASSIGNED", `${failure}-assigned`);
    record = step(record, "IN_DEVELOPMENT", `${failure}-dev`);
    record = step(record, "DEV_VALIDATED", `${failure}-validated`);
    record = step(record, "QA_REVIEW", `${failure}-qa`);
    if (failure !== "QA_FAILED") record = step(record, "ARCHITECTURE_REVIEW", `${failure}-arch`);
    if (failure === "UAT_FAILED") record = step(record, "UAT_REVIEW", `${failure}-uat`);
    const before = record.history.length;
    record = step(record, failure, `${failure}-failure`);
    record = step(record, "REWORK_REQUIRED", `${failure}-rework`);
    record = step(record, "IN_DEVELOPMENT", `${failure}-resume`);
    assert.equal(record.currentState, "IN_DEVELOPMENT");
    assert.equal(record.history.length, before + 3);
  }
});

test("transition table explicitly declares prerequisites", () => {
  assert.ok(TRANSITION_RULES.length > 0);
  assert.ok(TRANSITION_RULES.every((rule) => Array.isArray(rule.prerequisites)));
});
