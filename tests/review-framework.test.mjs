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
