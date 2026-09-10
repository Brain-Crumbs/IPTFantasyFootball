import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EVIDENCE_STORE_SUPPORTED_SCHEMAS,
  FileEvidenceStore,
  mergeEvidenceLineageId,
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

test("supported schema registry names validation-evidence at v1.0.0, review-result at v1.1.0, and merge-evidence at v1.0.0", () => {
  assert.deepEqual(EVIDENCE_STORE_SUPPORTED_SCHEMAS, {
    "ipt.validation-evidence": "1.0.0",
    "ipt.review-result": "1.1.0",
    "ipt.merge-evidence": "1.0.0",
  });
});

test("merge-evidence records derive a per-task merge lineage distinct from validator/role lineages", () => {
  withStore((store) => {
    const payload = {
      schemaId: "ipt.merge-evidence",
      schemaVersion: "1.0.0",
      evidenceId: "evidence-merge-1",
      taskId: "BOOT-025",
      revisionIdentity: "sha-aaa111",
      pullRequestNumber: 63,
      mergeCommitSha: "sha-merge-1",
      policyDecisionReference: "control-plane.merge-readiness:BOOT-025@sha-aaa111:ready",
      recordedAt: "2026-09-10T00:00:00Z",
    };

    const result = store.record(payload);
    assert.equal(result.ok, true);

    const lineageId = mergeEvidenceLineageId("BOOT-025");
    assert.equal(result.record.lineageId, lineageId);
    assert.notEqual(lineageId, validationEvidenceLineageId("BOOT-025", "npm-test"));
    assert.notEqual(lineageId, reviewResultLineageId("BOOT-025", "MergeController"));

    const current = store.getCurrent(lineageId);
    assert.equal(current.payload.mergeCommitSha, "sha-merge-1");
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
      schemaVersion: "1.1.0",
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

// Mirrors the store's internal injective directory-name encoding: every
// character outside [A-Za-z0-9-] becomes "_" plus its 4-digit hex UTF-16
// code unit, so no unescaped "_" ever appears in the output.
function safePart(value) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (/[A-Za-z0-9-]/.test(ch)) {
      out += ch;
    } else {
      out += `_${value.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

test("persistence is append-only on disk: each write creates a new numbered file", () => {
  withStore((store, root) => {
    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    store.record(validationEvidence({ revisionIdentity: "sha-aaa111" }));
    store.record(validationEvidence({ revisionIdentity: "sha-bbb222" }));
    const dir = join(root, safePart(lineageId));
    assert.ok(existsSync(join(dir, "0000001.json")));
    assert.ok(existsSync(join(dir, "0000002.json")));
  });
});

test("lineage directory encoding never collides for different validator ids", () => {
  withStore((store) => {
    // Before the fix, encodeURIComponent("/").replace(/%/g, "_") produced
    // "_2f", the same string a literal validatorId of "_2f" already maps to
    // unescaped. The injective encoding must keep these two lineages apart.
    const slashResult = store.record(validationEvidence({ taskId: "BOOT-020", validatorId: "a/b" }));
    const literalResult = store.record(validationEvidence({ taskId: "BOOT-020", validatorId: "a_002fb" }));
    assert.equal(slashResult.ok, true);
    assert.equal(literalResult.ok, true);
    assert.notEqual(slashResult.record.lineageId, literalResult.record.lineageId);

    const slashCurrent = store.getCurrent(validationEvidenceLineageId("BOOT-020", "a/b"));
    const literalCurrent = store.getCurrent(validationEvidenceLineageId("BOOT-020", "a_002fb"));
    assert.equal(slashCurrent.payload.validatorId, "a/b");
    assert.equal(literalCurrent.payload.validatorId, "a_002fb");
  });
});

test("a write that loses an exclusive-create race retries at the next sequence instead of failing", () => {
  withStore((store, root) => {
    const lineageId = validationEvidenceLineageId("BOOT-015", "npm-test");
    const dir = join(root, safePart(lineageId));
    mkdirSync(dir, { recursive: true });
    // Only 0000002.json exists, so the count-based initial guess
    // (existing.length + 1 === 2) collides with it on the exclusive
    // create — the same failure shape a genuine concurrent writer that
    // claimed sequence 2 between the directory listing and this call's
    // own write would produce. The store must retry rather than throw.
    writeFileSync(join(dir, "0000002.json"), "{}\n", "utf8");

    const result = store.record(validationEvidence());
    assert.equal(result.ok, true);
    assert.equal(result.record.sequence, 3);
    assert.ok(existsSync(join(dir, "0000003.json")));
  });
});

test("rejects a recordedAt with an out-of-range calendar date instead of accepting Date.parse's normalization", () => {
  withStore((store) => {
    // Date.parse("2026-02-30T00:00:00Z") silently rolls forward to March 2;
    // the schema's format: date-time must reject it outright.
    const result = store.record(validationEvidence({ recordedAt: "2026-02-30T00:00:00Z" }));
    assert.equal(result.ok, false);
    assert.equal(result.rejection.code, "SCHEMA_VALIDATION_FAILED");
    assert.ok(result.rejection.reasons.some((reason) => reason.includes("recordedAt")));
  });
});

test("rejects an out-of-range hour/month in recordedAt", () => {
  withStore((store) => {
    assert.equal(store.record(validationEvidence({ recordedAt: "2026-09-09T24:00:00Z" })).ok, false);
    assert.equal(store.record(validationEvidence({ recordedAt: "2026-13-01T00:00:00Z" })).ok, false);
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
