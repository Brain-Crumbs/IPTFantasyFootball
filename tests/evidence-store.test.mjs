import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  FileEvidenceStore,
  reviewResultLineageId,
  validationEvidenceLineageId,
} from "../dist/evidence-store/index.js";

const repositoryRoot = process.cwd();

function readFixture(name) {
  return JSON.parse(readFileSync(join(repositoryRoot, "schemas/fixtures/v1", name), "utf8"));
}

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), "ipt-evidence-"));
  try {
    return fn(new FileEvidenceStore(root, { repositoryRoot }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validationEvidence(overrides = {}) {
  return {
    schemaId: "ipt.validation-evidence",
    schemaVersion: "1.0.0",
    evidenceId: "evidence-1",
    taskId: "BOOT-015",
    revisionIdentity: "sha-aaa111",
    validatorId: "npm-test",
    outcome: "PASS",
    recordedAt: "2026-09-09T00:00:00Z",
    checks: [{ checkId: "all-pass", outcome: "PASS" }],
    ...overrides,
  };
}

test("supported schema registry names validation-evidence and review-result at v1.0.0", () => {
  assert.deepEqual(EVIDENCE_STORE_SUPPORTED_SCHEMAS, {
    "ipt.validation-evidence": "1.0.0",
    "ipt.review-result": "1.0.0",
  });
});

test("write/read evidence for one revision", () => {
  withStore((store) => {
    const result = store.record(validationEvidence());
    assert.equal(result.ok, true);
    assert.equal(result.record.sequence, 1);
    assert.equal(result.record.status, "CURRENT");
    assert.equal(result.record.payload.revisionIdentity, "sha-aaa111");

    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    assert.equal(result.record.lineageId, lineageId);
    const current = store.getCurrent(lineageId);
    assert.deepEqual(current, result.record);
  });
});

test("newer revision evidence supersedes without erasing the prior record", () => {
  withStore((store) => {
    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    const first = store.record(validationEvidence({ evidenceId: "evidence-1", revisionIdentity: "sha-aaa111" }));
    const second = store.record(validationEvidence({ evidenceId: "evidence-2", revisionIdentity: "sha-bbb222" }));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.record.sequence, first.record.sequence + 1);

    const history = store.getHistory(lineageId);
    assert.equal(history.length, 2);
    assert.equal(history[0].payload.evidenceId, "evidence-1");
    assert.equal(history[0].status, "SUPERSEDED");
    assert.equal(history[1].payload.evidenceId, "evidence-2");
    assert.equal(history[1].status, "CURRENT");

    const current = store.getCurrent(lineageId);
    assert.equal(current.payload.evidenceId, "evidence-2");
  });
});

test("query current evidence returns null for an unknown lineage", () => {
  withStore((store) => {
    assert.equal(store.getCurrent(validationEvidenceLineageId("BOOT-015", "unknown-validator")), null);
    assert.deepEqual(store.getHistory(validationEvidenceLineageId("BOOT-015", "unknown-validator")), []);
  });
});

test("separate validators for the same task keep independent lineages", () => {
  withStore((store) => {
    store.record(validationEvidence({ validatorId: "lint" }));
    store.record(validationEvidence({ validatorId: "npm-test" }));
    const lintCurrent = store.getCurrent(validationEvidenceLineageId("BOOT-015", "lint"));
    const testCurrent = store.getCurrent(validationEvidenceLineageId("BOOT-015", "npm-test"));
    assert.equal(lintCurrent.payload.validatorId, "lint");
    assert.equal(testCurrent.payload.validatorId, "npm-test");
  });
});

test("checkRevision reports CURRENT for the exact recorded revision", () => {
  withStore((store) => {
    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    store.record(validationEvidence({ revisionIdentity: "sha-aaa111" }));
    const check = store.checkRevision(lineageId, "sha-aaa111");
    assert.equal(check.status, "CURRENT");
    assert.equal(check.record.payload.revisionIdentity, "sha-aaa111");
  });
});

test("checkRevision makes a wrong-SHA mismatch visible instead of silently accepting it", () => {
  withStore((store) => {
    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    store.record(validationEvidence({ revisionIdentity: "sha-aaa111" }));
    const check = store.checkRevision(lineageId, "sha-ffffff-wrong");
    assert.equal(check.status, "REVISION_MISMATCH");
    assert.equal(check.expectedRevisionIdentity, "sha-ffffff-wrong");
    assert.equal(check.record.payload.revisionIdentity, "sha-aaa111");
  });
});

test("checkRevision reports NOT_FOUND for a lineage with no evidence", () => {
  withStore((store) => {
    const check = store.checkRevision(validationEvidenceLineageId("BOOT-015", "never-run"), "sha-aaa111");
    assert.equal(check.status, "NOT_FOUND");
  });
});

test("rejects a non-object payload", () => {
  withStore((store) => {
    const result = store.record("not-an-object");
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "INVALID_PAYLOAD");
  });
});

test("rejects an unsupported schemaId", () => {
  withStore((store) => {
    const result = store.record(validationEvidence({ schemaId: "ipt.unknown-schema" }));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "UNSUPPORTED_SCHEMA_ID");
  });
});

test("rejects an unsupported schemaVersion for a known schemaId", () => {
  withStore((store) => {
    const result = store.record(validationEvidence({ schemaVersion: "9.9.9" }));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "UNSUPPORTED_SCHEMA_VERSION");
  });
});

test("rejects the shared malformed validation-evidence fixture", () => {
  withStore((store) => {
    const result = store.record(readFixture("validation-evidence.invalid.json"));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "SCHEMA_VALIDATION_FAILED");
    assert.ok(result.rejection.reasons.length > 1, "expected multiple constraint violations to be reported");
  });
});

test("accepts the shared valid validation-evidence fixture", () => {
  withStore((store) => {
    const result = store.record(readFixture("validation-evidence.valid.json"));
    assert.equal(result.ok, true);
    assert.equal(result.record.payload.taskId, "BOOT-003");
  });
});

test("accepts the shared valid review-result fixture and keys its lineage by role", () => {
  withStore((store) => {
    const fixture = readFixture("review-result.valid.json");
    const result = store.record(fixture);
    assert.equal(result.ok, true);
    assert.equal(result.record.lineageId, reviewResultLineageId("BOOT-003", "Architect"));
  });
});

test("accepts every role-specific review-result shape in the shared fixture", () => {
  withStore((store) => {
    const fixtures = readFixture("review-result.roles-valid.json");
    assert.ok(fixtures.length >= 5, "expected one fixture per review role");
    for (const fixture of fixtures) {
      const result = store.record(fixture);
      assert.equal(result.ok, true, `expected role '${fixture.role}' to be accepted: ${JSON.stringify(result)}`);
      assert.equal(result.record.lineageId, reviewResultLineageId(fixture.taskId, fixture.role));
    }
  });
});

test("rejects the shared malformed review-result fixture", () => {
  withStore((store) => {
    const result = store.record(readFixture("review-result.invalid.json"));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "SCHEMA_VALIDATION_FAILED");
  });
});

test("rejects a FAIL outcome review-result missing the required nonPass detail", () => {
  withStore((store) => {
    const result = store.record(readFixture("review-result.nonpass-invalid.json"));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "SCHEMA_VALIDATION_FAILED");
    assert.ok(result.rejection.reasons.some((reason) => reason.includes("nonPass")));
  });
});

test("review-result and validation-evidence lineages for the same task never collide", () => {
  withStore((store) => {
    store.record(validationEvidence({ taskId: "BOOT-020", validatorId: "npm-test" }));
    store.record({
      schemaId: "ipt.review-result",
      schemaVersion: "1.0.0",
      reviewId: "review-npm-test",
      taskId: "BOOT-020",
      revisionIdentity: "sha-aaa111",
      role: "QA",
      outcome: "PASS",
      recordedAt: "2026-09-09T00:00:00Z",
      evidenceRefs: [],
      findings: [],
      details: {
        acceptanceCriteriaScenarios: ["scenario"],
        regressionNegativeCaseCoverage: ["regression"],
      },
    });

    const evidenceCurrent = store.getCurrent(validationEvidenceLineageId("BOOT-020", "npm-test"));
    const reviewCurrent = store.getCurrent(reviewResultLineageId("BOOT-020", "QA"));
    assert.equal(evidenceCurrent.payload.schemaId, "ipt.validation-evidence");
    assert.equal(reviewCurrent.payload.schemaId, "ipt.review-result");
  });
});

test("persistence is append-only on disk: each write creates a new numbered file", () => {
  withStore((store, root) => {
    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    store.record(validationEvidence({ revisionIdentity: "sha-aaa111" }));
    store.record(validationEvidence({ revisionIdentity: "sha-bbb222" }));
    const dir = join(root, encodeURIComponent(lineageId).replace(/%/g, "_"));
    assert.ok(existsSync(join(dir, "0000001.json")));
    assert.ok(existsSync(join(dir, "0000002.json")));
  });
});

test("rejects an unexpected property nested inside a $ref-resolved review-result details shape", () => {
  withStore((store) => {
    const fixture = readFixture("review-result.valid.json");
    fixture.details.unexpectedField = "x";
    const result = store.record(fixture);
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "SCHEMA_VALIDATION_FAILED");
    assert.ok(result.rejection.reasons.some((reason) => reason.includes("unexpectedField")));
  });
});

test("rejects a nonPass detail missing the required remediation field", () => {
  withStore((store) => {
    const fixture = readFixture("review-result.valid.json");
    fixture.outcome = "FAIL";
    fixture.nonPass = { reason: "because" };
    const result = store.record(fixture);
    assert.equal(result.ok, false);
    assert.ok(result.rejection.reasons.some((reason) => reason.includes("nonPass.remediation")));
  });
});

test("accepts a FAIL outcome once a complete nonPass detail is supplied", () => {
  withStore((store) => {
    const fixture = readFixture("review-result.valid.json");
    fixture.outcome = "FAIL";
    fixture.nonPass = { reason: "because", remediation: "fix it" };
    const result = store.record(fixture);
    assert.equal(result.ok, true);
  });
});

test("recording the same evidence for a fresh store is deterministic across repeated runs", () => {
  const outcomes = [1, 2].map(() =>
    withStore((store) => {
      const result = store.record(validationEvidence());
      return { sequence: result.record.sequence, lineageId: result.record.lineageId };
    }),
  );
  assert.deepEqual(outcomes[0], outcomes[1]);
});
