import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSITION_RULES,
  createLifecycleRecord,
  transitionLifecycle,
} from "../dist/lifecycle/index.js";

const all = [
  "DEPENDENCIES_SATISFIED","ASSIGNMENT_ACTIVE","BRANCH_VERIFIED","DEV_VALIDATION_PASSED",
  "QA_REVIEW_REQUESTED","ARCHITECTURE_REVIEW_REQUESTED","UAT_REVIEW_REQUESTED","QA_PASSED",
  "ARCHITECTURE_PASSED","UAT_PASSED","REVIEW_GATES_SATISFIED","MERGE_COMPLETED",
  "COMPLETION_RECORDED","FAILURE_EVIDENCE_RECORDED","REWORK_FINDINGS_RECORDED","REWORK_STARTED","BLOCKER_RECORDED",
];

const allReviews = ["Developer", "QA", "Architect", "UAT/Product", "MergeController"];

function request(record, toState, eventId, overrides = {}) {
  return {
    taskId: record.taskId,
    expectedState: record.currentState,
    toState,
    eventId,
    occurredAt: "2026-09-03T23:00:00.000Z",
    reason: `move to ${toState}`,
    evidenceRef: `evidence/${eventId}`,
    requiredReviewRoles: allReviews,
    satisfiedPrerequisites: all,
    actorId: "agent:test",
    runId: "run:test",
    revisionIdentity: "abc123",
    ...overrides,
  };
}

function step(record, toState, eventId, overrides = {}) {
  const result = transitionLifecycle(record, request(record, toState, eventId, overrides));
  assert.equal(result.ok, true, result.ok ? undefined : result.rejection.reason);
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
  const skip = transitionLifecycle(record, request(record, "IN_DEVELOPMENT", "skip"));
  assert.equal(skip.ok, false);
  assert.equal(skip.rejection.code, "ILLEGAL_TRANSITION");
  assert.strictEqual(skip.record, record);

  const missing = transitionLifecycle(record, request(record, "READY", "missing", { satisfiedPrerequisites: [] }));
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.rejection.missingPrerequisites, ["DEPENDENCIES_SATISFIED"]);
  assert.strictEqual(missing.record, record);
});

test("stale expected state rejects without mutation", () => {
  const planned = createLifecycleRecord("BOOT-009");
  const ready = step(planned, "READY", "ready");
  const stale = transitionLifecycle(ready, request(ready, "ASSIGNED", "stale", { expectedState: "PLANNED" }));
  assert.equal(stale.ok, false);
  assert.equal(stale.rejection.code, "STALE_EXPECTED_STATE");
  assert.strictEqual(stale.record, ready);
});

test("task-specific required review roles skip unrequired review gates without fabricated approvals", () => {
  const architectOnly = ["Developer", "Architect", "MergeController"];
  let record = createLifecycleRecord("BOOT-009");
  record = step(record, "READY", "role-ready", { requiredReviewRoles: architectOnly });
  record = step(record, "ASSIGNED", "role-assigned", { requiredReviewRoles: architectOnly });
  record = step(record, "IN_DEVELOPMENT", "role-dev", { requiredReviewRoles: architectOnly });
  record = step(record, "DEV_VALIDATED", "role-validated", { requiredReviewRoles: architectOnly });

  const wrongQa = transitionLifecycle(record, request(record, "QA_REVIEW", "role-wrong-qa", { requiredReviewRoles: architectOnly }));
  assert.equal(wrongQa.ok, false);
  assert.equal(wrongQa.rejection.code, "REVIEW_SEQUENCE_MISMATCH");
  assert.strictEqual(wrongQa.record, record);

  record = step(record, "ARCHITECTURE_REVIEW", "role-arch", { requiredReviewRoles: architectOnly });
  record = step(record, "MERGE_READY", "role-merge-ready", { requiredReviewRoles: architectOnly });
  assert.equal(record.currentState, "MERGE_READY");
  assert.equal(record.history.some((event) => event.toState === "QA_REVIEW" || event.toState === "UAT_REVIEW"), false);
});

test("pre-development states cannot enter BLOCKED and bypass deterministic start gates", () => {
  for (const state of ["PLANNED", "READY", "ASSIGNED"]) {
    let record = createLifecycleRecord("BOOT-009");
    if (state !== "PLANNED") record = step(record, "READY", `${state}-ready`);
    if (state === "ASSIGNED") record = step(record, "ASSIGNED", `${state}-assigned`);
    const blocked = transitionLifecycle(record, request(record, "BLOCKED", `${state}-blocked`));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.rejection.code, "ILLEGAL_TRANSITION");
    assert.strictEqual(blocked.record, record);
  }
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

test("schema-invalid transition metadata is rejected without mutation", () => {
  const record = createLifecycleRecord("BOOT-009");
  for (const overrides of [
    { reason: "" },
    { evidenceRef: "   " },
    { eventId: "" },
    { occurredAt: "not-a-date" },
    { actorId: "" },
  ]) {
    const result = transitionLifecycle(record, request(record, "READY", "invalid", overrides));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "INVALID_REQUEST");
    assert.strictEqual(result.record, record);
    assert.equal(record.history.length, 0);
  }
});

test("transition table explicitly declares prerequisites", () => {
  assert.ok(TRANSITION_RULES.length > 0);
  assert.ok(TRANSITION_RULES.every((rule) => Array.isArray(rule.prerequisites)));
});
