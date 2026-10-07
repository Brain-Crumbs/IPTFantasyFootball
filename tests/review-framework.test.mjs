import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileEvidenceStore, reviewResultLineageId } from "../dist/evidence-store/index.js";
import {
  ReviewFramework,
  ReviewFrameworkError,
  computeContextPackageId,
} from "../dist/review-framework/index.js";

const taskId = "BOOT-017";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const occurredAt = "2026-09-09T12:00:00Z";
const repositoryRoot = process.cwd();

function contextPackage(role, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    role,
    taskId,
    sourceRevision: revision,
    task: { taskId },
    artifacts: [],
    manifest: { included: [], excluded: [] },
    ...overrides,
  };
}

function withFramework(fn) {
  const root = mkdtempSync(join(tmpdir(), "ipt-review-framework-"));
  try {
    const evidenceStore = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });
    const framework = new ReviewFramework({ evidenceStore, evidenceLocation: root });
    return fn(framework, evidenceStore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function developerRequest(overrides = {}) {
  return {
    taskId,
    role: "Developer",
    revisionIdentity: revision,
    reviewerId: "dev-session-1",
    runId: "run-1",
    contextPackage: contextPackage("Developer"),
    outcome: "PASS",
    details: {
      implementationSummary: "Implemented the review framework.",
      changedSurfaces: ["src/review-framework/"],
      acceptanceCriteriaEvidence: ["all criteria met"],
      validationChecks: ["npm run build", "npm test"],
      knownLimitationsAssumptionsRisks: ["none"],
    },
    findings: [],
    evidenceRefs: [],
    occurredAt,
    ...overrides,
  };
}

function qaRequest(overrides = {}) {
  return {
    taskId,
    role: "QA",
    revisionIdentity: revision,
    reviewerId: "qa-session-1",
    runId: "run-1",
    contextPackage: contextPackage("QA"),
    outcome: "PASS",
    details: {
      acceptanceCriteriaScenarios: ["exercised PASS path"],
      regressionNegativeCaseCoverage: ["exercised rejection paths"],
    },
    findings: [],
    evidenceRefs: [],
    occurredAt,
    ...overrides,
  };
}

test("persists a Developer PASS handoff with no findings", () => {
  withFramework((framework) => {
    const result = framework.submit(developerRequest());
    assert.equal(result.outcome, "PASS");
    assert.equal(result.role, "Developer");
    assert.equal(result.evidenceSequence, 1);
    assert.equal(result.blockingFindings.length, 0);
    assert.equal(result.evidenceLineageId, reviewResultLineageId(taskId, "Developer"));
  });
});

test("persists an independent QA PASS once a matching Developer handoff exists", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    const result = framework.submit(qaRequest());
    assert.equal(result.outcome, "PASS");
    assert.equal(result.role, "QA");
    assert.equal(result.evidenceSequence, 1);
  });
});

test("persists a FAIL outcome with a blocking finding and required nonPass detail", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    const result = framework.submit(
      qaRequest({
        outcome: "FAIL",
        findings: [
          {
            findingId: "qa-1",
            severity: "HIGH",
            observed: "Endpoint returns 500.",
            expected: "Endpoint returns 200.",
          },
        ],
        nonPass: { reason: "Regression found.", remediation: "Fix the endpoint." },
      }),
    );
    assert.equal(result.outcome, "FAIL");
    assert.equal(result.blockingFindings.length, 1);
    assert.equal(result.blockingFindings[0].findingId, "qa-1");
  });
});

test("rejects a PASS outcome that carries an unresolved blocking finding", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    assert.throws(
      () =>
        framework.submit(
          qaRequest({
            outcome: "PASS",
            findings: [
              {
                findingId: "qa-2",
                severity: "MEDIUM",
                observed: "Missing negative-case coverage.",
                expected: "Negative cases covered.",
              },
            ],
          }),
        ),
      (error) => error instanceof ReviewFrameworkError && error.code === "PASS_WITH_BLOCKING_FINDINGS",
    );
  });
});

test("does not treat an INFO/LOW finding as blocking a PASS outcome", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    const result = framework.submit(
      qaRequest({
        findings: [
          {
            findingId: "qa-3",
            severity: "LOW",
            observed: "Minor naming inconsistency.",
            expected: "Consistent naming.",
          },
        ],
      }),
    );
    assert.equal(result.outcome, "PASS");
    assert.equal(result.blockingFindings.length, 0);
  });
});

test("rejects a non-PASS outcome that omits the nonPass reason/remediation", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    assert.throws(
      () => framework.submit(qaRequest({ outcome: "FAIL" })),
      (error) => error instanceof ReviewFrameworkError && error.code === "NON_PASS_MISSING_DETAIL",
    );
  });
});

test("rejects a submission whose context package targets a different revision", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    assert.throws(
      () =>
        framework.submit(
          qaRequest({ contextPackage: contextPackage("QA", { sourceRevision: "0000000000000000000000000000000000000000" }) }),
        ),
      (error) => error instanceof ReviewFrameworkError && error.code === "CONTEXT_PACKAGE_MISMATCH",
    );
  });
});

test("rejects a submission whose context package role does not match the requested role", () => {
  withFramework((framework) => {
    framework.submit(developerRequest());
    assert.throws(
      () => framework.submit(qaRequest({ contextPackage: contextPackage("Architect") })),
      (error) => error instanceof ReviewFrameworkError && error.code === "CONTEXT_PACKAGE_MISMATCH",
    );
  });
});

test("rejects independent review when no Developer handoff has been recorded", () => {
  withFramework((framework) => {
    assert.throws(
      () => framework.submit(qaRequest()),
      (error) => error instanceof ReviewFrameworkError && error.code === "DEVELOPER_HANDOFF_MISSING",
    );
  });
});

test("rejects independent review when the Developer handoff is bound to a different revision", () => {
  withFramework((framework) => {
    framework.submit(developerRequest({ revisionIdentity: "1111111111111111111111111111111111111111", contextPackage: contextPackage("Developer", { sourceRevision: "1111111111111111111111111111111111111111" }) }));
    assert.throws(
      () => framework.submit(qaRequest()),
      (error) => error instanceof ReviewFrameworkError && error.code === "DEVELOPER_HANDOFF_REVISION_MISMATCH",
    );
  });
});

test("rejects independent review when the Developer handoff did not PASS", () => {
  withFramework((framework) => {
    framework.submit(
      developerRequest({
        outcome: "BLOCKED",
        nonPass: { reason: "Cannot self-validate.", remediation: "Resolve environment issue." },
      }),
    );
    assert.throws(
      () => framework.submit(qaRequest()),
      (error) => error instanceof ReviewFrameworkError && error.code === "DEVELOPER_HANDOFF_NOT_PASSED",
    );
  });
});

test("rejects the Developer's own reviewer identity issuing the independent QA judgment for the same revision", () => {
  withFramework((framework) => {
    framework.submit(developerRequest({ reviewerId: "same-actor" }));
    assert.throws(
      () => framework.submit(qaRequest({ reviewerId: "same-actor" })),
      (error) => error instanceof ReviewFrameworkError && error.code === "SELF_APPROVAL_REJECTED",
    );
  });
});

test("permits a different reviewer identity to issue the independent QA judgment", () => {
  withFramework((framework) => {
    framework.submit(developerRequest({ reviewerId: "dev-actor" }));
    const result = framework.submit(qaRequest({ reviewerId: "qa-actor" }));
    assert.equal(result.outcome, "PASS");
  });
});

test("repeated review attempts for the same task/role create separate, queryable auditable records", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const first = framework.submit(qaRequest({ runId: "run-1" }));
    const second = framework.submit(
      qaRequest({
        runId: "run-2",
        outcome: "FAIL",
        findings: [
          {
            findingId: "qa-rerun-1",
            severity: "HIGH",
            observed: "Found on rerun.",
            expected: "Should not occur.",
          },
        ],
        nonPass: { reason: "Regression on rerun.", remediation: "Fix and resubmit." },
      }),
    );

    assert.equal(first.evidenceSequence, 1);
    assert.equal(second.evidenceSequence, 2);
    assert.notEqual(first.reviewId, second.reviewId);

    const history = evidenceStore.getHistory(reviewResultLineageId(taskId, "QA"));
    assert.equal(history.length, 2);
    assert.equal(history[0].status, "SUPERSEDED");
    assert.equal(history[1].status, "CURRENT");
    assert.equal(history[1].payload.outcome, "FAIL");
  });
});

test("a review result cannot be accepted without taskId, role, exact revision, outcome, or findings", () => {
  withFramework((framework) => {
    assert.throws(() => framework.submit(qaRequest({ taskId: "not-a-task-id" })), ReviewFrameworkError);
    assert.throws(() => framework.submit(qaRequest({ role: "Owner" })), ReviewFrameworkError);
    assert.throws(() => framework.submit(qaRequest({ revisionIdentity: "" })), ReviewFrameworkError);
    assert.throws(() => framework.submit(qaRequest({ outcome: "APPROVED" })), ReviewFrameworkError);
    assert.throws(() => framework.submit(qaRequest({ findings: "not-an-array" })), ReviewFrameworkError);
    assert.throws(() => framework.submit(qaRequest({ reviewerId: "" })), ReviewFrameworkError);
  });
});

test("computeContextPackageId is deterministic for identical content and differs for different content", () => {
  const a = contextPackage("QA");
  const b = contextPackage("QA");
  const c = contextPackage("QA", { sourceRevision: "0000000000000000000000000000000000000000" });

  assert.equal(computeContextPackageId(a), computeContextPackageId(b));
  assert.notEqual(computeContextPackageId(a), computeContextPackageId(c));
});

test("the recorded review-result evidence carries the reviewerId and contextPackageId used to bind the judgment", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const result = framework.submit(qaRequest());
    const record = evidenceStore.getCurrent(reviewResultLineageId(taskId, "QA"));
    assert.equal(record.payload.reviewerId, "qa-session-1");
    assert.equal(record.payload.contextPackageId, result.contextPackageId);
  });
});

test("an exact retry reuses the current Developer and QA evidence after framework recreation", () => {
  withFramework((framework, evidenceStore) => {
    const developer = developerRequest();
    const qa = qaRequest();
    const firstDeveloper = framework.submit(developer);
    const firstQa = framework.submit(qa);
    const recreated = new ReviewFramework({
      evidenceStore: new FileEvidenceStore(join(firstQa.evidenceLocation, "evidence"), { repositoryRoot }),
      evidenceLocation: firstQa.evidenceLocation,
    });
    assert.deepEqual(recreated.submit(structuredClone(developer)), firstDeveloper);
    assert.deepEqual(recreated.submit(structuredClone(qa)), firstQa);
    assert.equal(evidenceStore.getHistory(firstDeveloper.evidenceLineageId).length, 1);
    assert.equal(evidenceStore.getHistory(firstQa.evidenceLineageId).length, 1);
  });
});

test("exact FAIL and BLOCKED retries reuse one durable record without erasing the failed judgment", () => {
  for (const outcome of ["FAIL", "BLOCKED"]) {
    withFramework((framework, evidenceStore) => {
      framework.submit(developerRequest());
      const request = qaRequest({
        outcome,
        findings: [{ findingId: "f1", severity: "HIGH", observed: "Broken behavior", expected: "Correct behavior" }],
        nonPass: { reason: "Unmet requirement", remediation: "Repair the behavior" },
      });
      const first = framework.submit(request);
      assert.deepEqual(framework.submit(structuredClone(request)), first);
      assert.equal(first.blockingFindings.length, 1);
      assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
      assert.equal(evidenceStore.getCurrent(first.evidenceLineageId).payload.outcome, outcome);
    });
  }
});

test("retry identity comparison is independent of object key ordering", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit(request);
    const reordered = { ...request, details: Object.fromEntries(Object.entries(request.details).reverse()) };
    assert.deepEqual(framework.submit(reordered), first);
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
  });
});

test("same review identity with a different payload fails closed without appending", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit(request);
    const conflicts = [
      { reviewerId: "different-independent-reviewer" },
      { occurredAt: "2026-09-09T12:00:01Z" },
      { evidenceRefs: ["another-evidence-record"] },
      { details: { ...request.details, acceptanceCriteriaScenarios: ["different scenario"] } },
      { contextPackage: contextPackage("QA", { task: { taskId, title: "Changed context" } }) },
      { findings: [{ findingId: "f1", severity: "LOW", observed: "Naming", expected: "Consistent naming" }] },
      { outcome: "FAIL", nonPass: { reason: "Changed judgment", remediation: "Fix the regression" } },
    ];
    for (const conflict of conflicts) {
      assert.throws(() => framework.submit({ ...request, ...conflict }), (error) =>
        error instanceof ReviewFrameworkError && error.code === "REVIEW_ID_CONFLICT" && error.recoverable === false);
    }
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
    assert.equal(evidenceStore.getCurrent(first.evidenceLineageId).payload.outcome, "PASS");
  });
});

test("retrying a superseded PASS cannot hide a newer FAIL at the same revision", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit(request);
    const latest = framework.submit(qaRequest({
      runId: "new-review-attempt", outcome: "FAIL",
      nonPass: { reason: "Found a regression", remediation: "Fix before a new attempt" },
    }));
    assert.throws(() => framework.submit(request), (error) =>
      error instanceof ReviewFrameworkError && error.code === "EVIDENCE_REJECTED" && error.recoverable === false);
    const history = evidenceStore.getHistory(first.evidenceLineageId);
    assert.equal(history.length, 2);
    assert.equal(history[0].status, "SUPERSEDED");
    assert.equal(history[1].payload.reviewId, latest.reviewId);
    assert.equal(history[1].payload.outcome, "FAIL");
  });
});

test("retrying a superseded Developer handoff cannot restore approval for an old revision", () => {
  withFramework((framework, evidenceStore) => {
    const request = developerRequest();
    const first = framework.submit(request);
    const nextRevision = "0000000000000000000000000000000000000000";
    const latest = framework.submit(developerRequest({
      runId: "new-development-attempt", revisionIdentity: nextRevision,
      contextPackage: contextPackage("Developer", { sourceRevision: nextRevision }),
    }));
    assert.throws(() => framework.submit(request), (error) =>
      error instanceof ReviewFrameworkError && error.code === "EVIDENCE_REJECTED");
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 2);
    assert.equal(evidenceStore.getCurrent(first.evidenceLineageId).payload.reviewId, latest.reviewId);
  });
});

test("a duplicate persisted review identity is rejected without appending another record", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit(request);
    evidenceStore.record(evidenceStore.getCurrent(first.evidenceLineageId).payload);
    assert.throws(() => framework.submit(request), (error) =>
      error instanceof ReviewFrameworkError && error.code === "EVIDENCE_REJECTED" && error.recoverable === false);
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 2);
  });
});

test("a retry still enforces the current Developer handoff rather than trusting old QA evidence", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit(request);
    framework.submit(developerRequest({
      runId: "changed-developer-handoff", outcome: "FAIL",
      nonPass: { reason: "Validation regressed", remediation: "Fix validation" },
    }));
    assert.throws(() => framework.submit(request), (error) =>
      error instanceof ReviewFrameworkError && error.code === "DEVELOPER_HANDOFF_NOT_PASSED");
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
  });
});

function evidenceStorePort(store, overrides) {
  return {
    record: (payload) => store.record(payload),
    validate: (payload) => store.validate(payload),
    getCurrent: (lineageId) => store.getCurrent(lineageId),
    getHistory: (lineageId) => store.getHistory(lineageId),
    checkRevision: (lineageId, revisionIdentity) => store.checkRevision(lineageId, revisionIdentity),
    ...overrides,
  };
}

test("retry rejects persisted payload, lineage, or sequence corruption instead of trusting its identity fields", () => {
  const corruptions = [
    (record) => ({ ...record, payload: { ...record.payload, schemaVersion: "9.9.9" } }),
    (record) => ({ ...record, lineageId: "BOOT-999::role::QA" }),
    (record) => ({ ...record, sequence: 0 }),
    (record) => ({ ...record, sequence: 1.5 }),
  ];
  for (const corrupt of corruptions) {
    withFramework((framework, evidenceStore) => {
      framework.submit(developerRequest());
      const request = qaRequest();
      const first = framework.submit(request);
      const corrupted = new ReviewFramework({
        evidenceLocation: "test",
        evidenceStore: evidenceStorePort(evidenceStore, {
          getHistory: (lineageId) => evidenceStore.getHistory(lineageId).map(corrupt),
        }),
      });
      assert.throws(() => corrupted.submit(request), (error) =>
        error instanceof ReviewFrameworkError && error.code === "EVIDENCE_REJECTED" && error.recoverable === false);
      assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
    });
  }
});

test("persisted readback must match the exact current review, not merely its revision", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit(request);
    const current = evidenceStore.getCurrent(first.evidenceLineageId);
    const replacements = [
      { ...current, status: "SUPERSEDED" },
      { ...current, sequence: current.sequence + 1 },
      { ...current, payload: { ...current.payload, reviewId: `${current.payload.reviewId}:replacement` } },
    ];
    for (const record of replacements) {
      const changedReadback = new ReviewFramework({
        evidenceLocation: "test",
        evidenceStore: evidenceStorePort(evidenceStore, { checkRevision: () => ({ status: "CURRENT", record }) }),
      });
      assert.throws(() => changedReadback.submit(request), (error) =>
        error instanceof ReviewFrameworkError && error.code === "EVIDENCE_REJECTED" && error.recoverable === false);
    }
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
  });
});

test("retry resumes from evidence persisted before an interrupted acknowledgement without appending", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const interruption = Object.assign(new Error("Connection lost after durable append"), { code: "EIO" });
    const interrupted = new ReviewFramework({
      evidenceLocation: "test",
      evidenceStore: evidenceStorePort(evidenceStore, {
        record(payload) {
          const recorded = evidenceStore.record(payload);
          assert.equal(recorded.ok, true);
          throw interruption;
        },
      }),
    });
    assert.throws(() => interrupted.submit(request), (error) => error === interruption);
    const result = framework.submit(request);
    assert.equal(result.evidenceSequence, 1);
    assert.equal(result.outcome, "PASS");
    assert.equal(evidenceStore.getHistory(result.evidenceLineageId).length, 1);
  });
});

test("retry refuses invalid current Developer handoff evidence even when matching QA evidence exists", () => {
  const corruptions = [
    (record) => ({ ...record, status: "SUPERSEDED" }),
    (record) => ({ ...record, payload: { ...record.payload, reviewerId: undefined } }),
    (record) => ({ ...record, payload: { ...record.payload, taskId: "BOOT-999" } }),
  ];
  for (const corrupt of corruptions) {
    withFramework((framework, evidenceStore) => {
      framework.submit(developerRequest());
      const request = qaRequest();
      const first = framework.submit(request);
      const changedHandoff = new ReviewFramework({
        evidenceLocation: "test",
        evidenceStore: evidenceStorePort(evidenceStore, {
          getCurrent: (lineageId) => corrupt(evidenceStore.getCurrent(lineageId)),
        }),
      });
      assert.throws(() => changedHandoff.submit(request), (error) =>
        error instanceof ReviewFrameworkError && error.code === "EVIDENCE_REJECTED" && error.recoverable === false);
      assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
    });
  }
});

test("exact retry comparison preserves JSON __proto__ keys in the compiled context identity", () => {
  withFramework((framework, evidenceStore) => {
    framework.submit(developerRequest());
    const request = qaRequest();
    const first = framework.submit({ ...request, contextPackage: contextPackage("QA", {
      task: JSON.parse('{"taskId":"BOOT-017","__proto__":{"requirement":"first"}}'),
    }) });
    assert.throws(() => framework.submit({ ...request, contextPackage: contextPackage("QA", {
      task: JSON.parse('{"taskId":"BOOT-017","__proto__":{"requirement":"changed"}}'),
    }) }), (error) => error instanceof ReviewFrameworkError && error.code === "REVIEW_ID_CONFLICT");
    assert.equal(evidenceStore.getHistory(first.evidenceLineageId).length, 1);
  });
});
