import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDiagnostics } from "../dist/workflow-diagnostics/diagnostics.js";
import { FileEvidenceStore, reviewResultLineageId, validationEvidenceLineageId } from "../dist/evidence-store/index.js";
import { DEFAULT_REQUIRED_CI_CHECKS, MergeReadinessError, MergeReadinessPolicyEngine } from "../dist/merge-readiness/index.js";
import { transitionLifecycle } from "../dist/lifecycle/index.js";

const observedAt = "2026-10-07T23:00:00Z";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const taskId = "BOOT-031";
const repositoryRoot = new URL("..", import.meta.url).pathname;
function task(id = taskId, overrides = {}) {
  return { schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: id, title: `Task ${id}`, objective: "Explain deterministic blockers",
    inScope: ["Read-only diagnostics"], outOfScope: ["Repairing state"], dependencies: [], canonicalBranch: `bootstrap/${id.toLowerCase()}-diagnostics`,
    allowedPaths: ["src/"], requirements: ["Explain gates"], acceptanceCriteria: ["Concrete predicates"], validationPlan: ["Tests"],
    affectedContracts: [], requiredReviewRoles: ["QA", "Architect", "UAT/Product"], sourcePath: `tasks/definitions/${id}.task.json`, ...overrides };
}
function validator(validatorId = "repository:build", required = true) {
  return { validatorId, required, kind: "function", category: "test", execute() { assert.fail("Diagnostics must never execute a validator"); } };
}
function transition(t, overrides = {}) {
  return { taskId: t.taskId, expectedState: "PLANNED", toState: "READY", eventId: "preview-event", occurredAt: observedAt,
    reason: "Preview only", evidenceRef: "request-evidence", revisionIdentity: revision,
    requiredReviewRoles: [...t.requiredReviewRoles], satisfiedPrerequisites: [], ...overrides };
}
function tree(path) {
  if (!existsSync(path)) return null;
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(e => [e.name, e.isDirectory() ? tree(join(path, e.name)) : readFileSync(join(path, e.name), "utf8")]));
}
function setup(t, tasks = [task()], options = {}) {
  const root = mkdtempSync(join(tmpdir(), "ipt-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const states = new Map(), assignments = new Map(), revisions = new Map(tasks.map(t => [t.taskId, revision])), lineages = new Map();
  const writer = new FileEvidenceStore(join(root, "evidence"), { repositoryRoot });
  const source = { registry: new Map(tasks.map(t => [t.taskId, t])),
    lifecycle: { get: id => states.get(id) ?? null, save() { assert.fail("Lifecycle write"); } },
    assignments: { get: id => assignments.get(id) ?? null, acquire() { assert.fail("Assignment write"); } },
    revisions: { get: t => revisions.get(t.taskId) ?? null },
    validationLineages: { list: id => lineages.get(id) ?? [] },
    evidence: { getHistory: id => writer.getHistory(id), validate: payload => writer.validate(payload), record() { assert.fail("Evidence write"); } } };
  const resolverCalls = [];
  const validatorResolver = options.validatorResolver ?? { resolve(t, rev) { resolverCalls.push([t.taskId, rev]); return options.validators ?? [validator()]; } };
  const dependencies = { source, validatorResolver, ...(options.mergeReadiness === undefined ? {} : { mergeReadiness: options.mergeReadiness }) };
  const setState = (id, state, rev = revision, history = []) => {
    const previous = history.at(-1)?.toState ?? "PLANNED";
    const event = { eventId: `event-${state}`, taskId: id, fromState: previous, toState: state, occurredAt: observedAt,
      reason: `Recorded ${state}`, evidenceRef: `lifecycle-${state}`, ...(rev === null ? {} : { revisionIdentity: rev }) };
    const record = { schemaId: "ipt.lifecycle-state", schemaVersion: "1.1.0", taskId: id, currentState: state, history: [...history, event] };
    states.set(id, record); return record;
  };
  const record = payload => { const result = writer.record(payload); assert.equal(result.ok, true, JSON.stringify(result)); return result.record; };
  const validate = (id = taskId, { validatorId = "repository:build", outcome = "PASS", rev = revision, details = "" } = {}) => {
    const lineage = validationEvidenceLineageId(id, validatorId);
    lineages.set(id, [...new Set([...(lineages.get(id) ?? []), lineage])]);
    return record({ schemaId: "ipt.validation-evidence", schemaVersion: "1.0.0", taskId: id, evidenceId: `validation-${validatorId}-${outcome}`,
      validatorId, revisionIdentity: rev, outcome, checks: [{ checkId: validatorId, outcome, ...(details ? { details } : {}) }], recordedAt: observedAt });
  };
  const review = (id = taskId, role = "Architect", { outcome = "PASS", rev = revision, findings = [] } = {}) => {
    const details = {
      QA: { acceptanceCriteriaScenarios: [], regressionNegativeCaseCoverage: [] },
      Architect: { affectedContractsModules: [], dependencyConsumerSurfaces: [], semanticCompatibilityAssessment: "Compatible", invariantDependencyRuleAssessment: "Preserved" },
      "UAT/Product": { objectiveInterpretation: "Explain gates", userOutcomeScenarios: [], observedBehavior: [] },
    };
    return record({ schemaId: "ipt.review-result", schemaVersion: "1.1.0", taskId: id, reviewId: `review-${role}`, role,
      revisionIdentity: rev, outcome, details: details[role], findings, evidenceRefs: [], recordedAt: observedAt,
      ...(outcome === "PASS" ? {} : { nonPass: { reason: "Recorded review reason", remediation: "Address the finding" } }) });
  };
  const snapshot = () => JSON.stringify({ states: [...states], assignments: [...assignments], revisions: [...revisions],
    registry: [...source.registry], lineages: [...lineages], files: tree(root) });
  return { root, tasks, source, dependencies, diagnostics: new WorkflowDiagnostics(dependencies), states, assignments, revisions,
    resolverCalls, writer, setState, validate, review, snapshot };
}
function assertEnvelope(result, subject, scope) {
  assert.equal(result.diagnosticsVersion, "1.0.0"); assert.equal(result.subject, subject); assert.equal(result.scope, scope);
  assert.equal(result.observedAt, observedAt); assert.equal(result.clear, result.findings.length === 0);
  assert.ok(result.notes.some(n => /not gate approval|cannot authorize merge/.test(n)));
  for (const f of result.findings) {
    assert.ok(["missing", "failed", "stale", "blocked"].includes(f.condition));
    for (const text of [f.code, f.predicate, f.message, f.remediation.action, f.remediation.reference]) assert.ok(text.length > 0);
    assert.equal(f.references.taskId, result.taskId);
  }
}
function mergeEngine(s, options = {}) {
  const t = s.tasks.find(t => t.taskId === taskId);
  const ciCalls = [], prCalls = [], approvalCalls = [];
  const engine = new MergeReadinessPolicyEngine({ registry: s.source.registry,
    branchLifecycle: { canonicalBranch: t => t.canonicalBranch, assertCurrentTaskBranch() {}, currentRevision: () => s.revisions.get(taskId) },
    lifecycleState: s.source.lifecycle,
    approvals: { getApprovalStatus(request) { approvalCalls.push(request); return { taskId, revision: s.revisions.get(taskId), roles: options.roles ?? [] }; } },
    evidence: { getCurrent: id => s.writer.getCurrent(id) },
    ciStatus: { async listCheckRuns(ref, name) {
      ciCalls.push([ref, name]);
      if (options.ciError) throw options.ciError;
      return options.checks?.[name] ?? [{ name, status: "completed", conclusion: "success", startedAt: observedAt }];
    } },
    pullRequests: { async findOpenPullRequests(params) {
      prCalls.push(params);
      if (options.prError) throw options.prError;
      return options.prs ?? [{ number: 77, htmlUrl: "https://github.com/example/repository/pull/77", headRef: t.canonicalBranch,
        headSha: revision, baseRef: "main", title: "Diagnostics", body: "Fixture", state: "open", ...options.pr }];
    } },
  });
  s.dependencies.mergeReadiness = engine;
  return { engine, ciCalls, prCalls, approvalCalls };
}

test("task diagnostics name direct and transitive unsatisfied dependencies even when another task is selectable", t => {
  const s = setup(t, [task("BOOT-029"), task("BOOT-030", { dependencies: ["BOOT-029"] }), task(taskId, { dependencies: ["BOOT-030"] })]);
  const result = s.diagnostics.explainTask(taskId, observedAt);
  assertEnvelope(result, "task", "NEXT_TASK_ELIGIBILITY"); assert.equal(result.clear, false); assert.equal(result.nextTaskId, "BOOT-029");
  assert.deepEqual(result.findings.map(f => [f.code, f.references.dependencyTaskId]), [
    ["TASK_DEPENDENCY_UNSATISFIED", "BOOT-030"], ["TASK_TRANSITIVE_DEPENDENCY_UNSATISFIED", "BOOT-029"],
  ]);
  s.setState("BOOT-030", "DONE");
  assert.deepEqual(s.diagnostics.explainTask(taskId, observedAt).findings.map(f => f.references.dependencyTaskId), ["BOOT-029"]);
  s.setState("BOOT-029", "DONE"); assert.equal(s.diagnostics.explainTask(taskId, observedAt).clear, true);
});
test("eligibility is scoped to the requested task rather than whether it wins next-task selection", t => {
  const s = setup(t, [task("BOOT-030"), task()]);
  const result = s.diagnostics.explainTask(taskId, observedAt);
  assert.equal(result.clear, true); assert.equal(result.nextTaskId, "BOOT-030");
  assert.match(result.notes.join(" "), /rank behind another eligible task/);
  s.setState(taskId, "IN_DEVELOPMENT");
  assert.equal(s.diagnostics.explainTask(taskId, observedAt).findings[0].code, "TASK_STATE_INELIGIBLE");
  s.setState(taskId, "DONE"); assert.equal(s.diagnostics.explainTask(taskId, observedAt).clear, false);
});
test("task eligibility does not reinterpret expired assignment or missing branch as selection policy", t => {
  const s = setup(t); s.revisions.clear();
  s.assignments.set(taskId, { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId, canonicalBranch: s.tasks[0].canonicalBranch,
    status: "ACTIVE", lockId: "lock-1", ownerId: "developer", runId: "run-1", acquiredAt: "2026-10-06T00:00:00Z", expiresAt: "2026-10-07T00:00:00Z" });
  const before = s.snapshot(); const result = s.diagnostics.explainTask(taskId, observedAt);
  assert.equal(result.clear, true); assert.equal(result.revision, null); assert.equal(s.snapshot(), before);
  assert.match(result.notes.join(" "), /Assignment, branch, and start gates remain separate/);
});
test("illegal transition reports the unchanged lifecycle engine's exact rejection", t => {
  const s = setup(t); const state = s.setState(taskId, "IN_DEVELOPMENT");
  const request = transition(s.tasks[0], { expectedState: "IN_DEVELOPMENT", toState: "DONE" });
  const expected = transitionLifecycle(state, request); const result = s.diagnostics.explainTransition(request, observedAt);
  assertEnvelope(result, "transition", "SUPPLIED_TRANSITION_REQUEST_PREVIEW");
  assert.equal(result.findings[0].code, "ILLEGAL_TRANSITION"); assert.equal(result.findings[0].condition, "blocked");
  assert.equal(result.findings[0].message, expected.rejection.reason);
  assert.equal(result.findings[0].references.evidenceRef, request.evidenceRef); assert.deepEqual(s.states.get(taskId), state);
});
test("transition diagnostics enumerate every missing prerequisite and distinguish stale expected state", t => {
  const s = setup(t); s.setState(taskId, "QA_REVIEW");
  const request = transition(s.tasks[0], { expectedState: "QA_REVIEW", toState: "ARCHITECTURE_REVIEW" });
  const missing = s.diagnostics.explainTransition(request, observedAt);
  assert.deepEqual(missing.findings.map(f => [f.condition, f.references.prerequisite]), [
    ["missing", "QA_PASSED"], ["missing", "ARCHITECTURE_REVIEW_REQUESTED"],
  ]);
  assert.deepEqual(missing.transition.requiredPrerequisites, ["QA_PASSED", "ARCHITECTURE_REVIEW_REQUESTED"]);
  const stale = s.diagnostics.explainTransition({ ...request, expectedState: "DEV_VALIDATED" }, observedAt);
  assert.equal(stale.findings[0].code, "STALE_EXPECTED_STATE"); assert.equal(stale.findings[0].condition, "stale");
  assert.match(stale.findings[0].message, /current state is 'QA_REVIEW'/);
});
test("transition previews cannot skip a declared review or replace registered role policy", t => {
  const s = setup(t); s.setState(taskId, "DEV_VALIDATED");
  const request = transition(s.tasks[0], { expectedState: "DEV_VALIDATED", toState: "MERGE_READY", satisfiedPrerequisites: ["REVIEW_GATES_SATISFIED"] });
  const result = s.diagnostics.explainTransition(request, observedAt);
  assert.equal(result.findings[0].code, "REVIEW_SEQUENCE_MISMATCH");
  assert.throws(() => s.diagnostics.explainTransition({ ...request, requiredReviewRoles: [] }, observedAt), /requiredReviewRoles.*registered/);
});
test("successful transition preview never saves a transition or verifies caller prerequisite assertions", t => {
  const s = setup(t); const request = transition(s.tasks[0], { satisfiedPrerequisites: ["DEPENDENCIES_SATISFIED"] });
  const before = s.snapshot(); const result = s.diagnostics.explainTransition(request, observedAt);
  assert.equal(result.clear, true); assert.equal(result.state, "PLANNED"); assert.equal(s.snapshot(), before);
  assert.equal(s.states.has(taskId), false); assert.match(result.notes.join(" "), /caller assertions/);
});
test("transition diagnostics freeze their own output without freezing caller-owned request arrays", t => {
  const s = setup(t); const request = transition(s.tasks[0], { satisfiedPrerequisites: ["DEPENDENCIES_SATISFIED"] });
  const before = structuredClone(request); const result = s.diagnostics.explainTransition(request, observedAt);
  assert.deepEqual(request, before); assert.equal(Object.isFrozen(request.requiredReviewRoles), false);
  assert.equal(Object.isFrozen(request.satisfiedPrerequisites), false);
  assert.equal(Object.isFrozen(result.transition.suppliedPrerequisites), true);
});
test("validation diagnostics resolve required validators for the exact task and canonical revision", t => {
  const s = setup(t, [task()], { validators: [validator(), validator("repository:test")] });
  s.validate(); const result = s.diagnostics.explainValidation(taskId, observedAt);
  assertEnvelope(result, "validation", "REQUIRED_VALIDATOR_EVIDENCE");
  assert.deepEqual(s.resolverCalls, [[taskId, revision]]);
  assert.deepEqual(result.evidence.map(e => [e.subject, e.currency, e.required]), [["repository:build", "CURRENT", true], ["repository:test", "NONE", true]]);
  assert.equal(result.findings[0].condition, "missing"); assert.equal(result.findings[0].references.validatorId, "repository:test");
});
test("a new commit makes developer validation artifacts and persisted handoff stale", t => {
  const s = setup(t); s.validate(); s.setState(taskId, "DEV_VALIDATED"); s.revisions.set(taskId, "new-commit");
  const result = s.diagnostics.explainValidation(taskId, observedAt);
  assert.deepEqual(result.findings.map(f => f.code), ["VALIDATOR_EVIDENCE_STALE", "DEV_VALIDATION_TRANSITION_STALE"]);
  for (const f of result.findings) {
    assert.equal(f.condition, "stale"); assert.equal(f.references.revisionIdentity, revision); assert.equal(f.references.expectedRevision, "new-commit");
  }
  assert.equal(result.findings[0].references.evidenceRef, `${validationEvidenceLineageId(taskId, "repository:build")}@1`);
  assert.equal(result.findings[1].references.evidenceRef, "lifecycle-DEV_VALIDATED");
});
test("current validator evidence cannot conceal a missing or revisionless DEV_VALIDATED lifecycle handoff", t => {
  const s = setup(t); s.validate(); s.setState(taskId, "QA_REVIEW");
  assert.equal(s.diagnostics.explainValidation(taskId, observedAt).findings[0].code, "DEV_VALIDATION_TRANSITION_MISSING");
  const state = s.setState(taskId, "DEV_VALIDATED", null);
  assert.equal(s.diagnostics.explainValidation(taskId, observedAt).findings[0].condition, "missing");
  state.history[0].revisionIdentity = revision;
  assert.equal(s.diagnostics.explainValidation(taskId, observedAt).clear, true);
});
test("validation FAIL, BLOCKED and missing records retain distinct concrete conditions", t => {
  const s = setup(t, [task()], { validators: [validator("failed"), validator("blocked"), validator("missing")] });
  s.validate(taskId, { validatorId: "failed", outcome: "FAIL", details: "Compilation failed" });
  s.validate(taskId, { validatorId: "blocked", outcome: "BLOCKED", details: "Build tool unavailable" });
  const result = s.diagnostics.explainValidation(taskId, observedAt);
  assert.deepEqual(result.findings.map(f => [f.references.validatorId, f.condition]), [["failed", "failed"], ["blocked", "blocked"], ["missing", "missing"]]);
  assert.match(result.findings[0].message, /Compilation failed/); assert.match(result.findings[1].message, /Build tool unavailable/);
});
test("optional validator failures and undeclared old lineages never become required blockers", t => {
  const s = setup(t, [task()], { validators: [validator(), validator("optional", false)] });
  s.validate(); s.validate(taskId, { validatorId: "optional", outcome: "FAIL" }); s.validate(taskId, { validatorId: "retired", outcome: "FAIL" });
  const result = s.diagnostics.explainValidation(taskId, observedAt);
  assert.equal(result.clear, true); assert.deepEqual(result.evidence.map(e => [e.subject, e.required]), [["repository:build", true], ["optional", false]]);
  assert.equal(result.evidence[1].outcome, "FAIL"); assert.equal(result.state, "PLANNED");
  assert.match(result.notes.join(" "), /not gate approval/);
});
test("latest validator lineage never falls back to an older matching PASS", t => {
  const s = setup(t); s.validate(); s.validate(taskId, { rev: "other-commit" });
  const result = s.diagnostics.explainValidation(taskId, observedAt);
  assert.equal(result.clear, false); assert.equal(result.evidence[0].currency, "STALE"); assert.equal(result.evidence[0].sequence, 2);
  assert.equal(result.evidence[0].historyCount, 2); assert.match(result.findings[0].references.evidenceRef, /@2$/);
});
test("missing canonical revision is explicit and never invokes validator resolution for another HEAD", t => {
  const s = setup(t); s.validate(); s.revisions.clear();
  const result = s.diagnostics.explainValidation(taskId, observedAt);
  assert.equal(result.revision, null); assert.equal(result.findings[0].code, "REVISION_UNAVAILABLE");
  assert.equal(result.findings[0].condition, "missing"); assert.deepEqual(s.resolverCalls, []); assert.deepEqual(result.evidence, []);
});
test("empty, duplicate, or invalid validator resolutions fail closed rather than returning clear", t => {
  const cases = [
    [[], "EMPTY_VALIDATOR_SET"], [[validator(), validator()], "DUPLICATE_VALIDATOR_ID"],
    [[{ ...validator(), validatorId: " " }], "INVALID_VALIDATOR_SPEC"], [[{ ...validator(), required: "true" }], "INVALID_VALIDATOR_SPEC"],
    [[{ ...validator(), category: "invented-category" }], "INVALID_VALIDATOR_SPEC"],
    [[{ ...validator(), kind: "command", command: "" }], "INVALID_VALIDATOR_SPEC"],
    [[{ ...validator(), execute: undefined }], "INVALID_VALIDATOR_SPEC"],
  ];
  for (const [validators, code] of cases) {
    const s = setup(t, [task()], { validators });
    assert.throws(() => s.diagnostics.explainValidation(taskId, observedAt), error => error.code === code);
  }
});
test("missing Architecture approval names its required role and does not invent Developer approval", t => {
  const s = setup(t, [task(taskId, { requiredReviewRoles: ["Developer", "QA", "Architect", "MergeController"] })]);
  s.review(taskId, "QA"); const result = s.diagnostics.explainReviews(taskId, observedAt);
  assertEnvelope(result, "reviews", "DECLARED_INDEPENDENT_REVIEW_EVIDENCE");
  assert.deepEqual(result.evidence.map(e => e.subject), ["QA", "Architect"]);
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0].code, "REVIEW_EVIDENCE_MISSING");
  assert.equal(result.findings[0].references.role, "Architect"); assert.match(result.findings[0].remediation.action, /independent 'Architect'/);
});
test("review evidence distinguishes missing, failed, stale and blocked without losing finding IDs", t => {
  const s = setup(t); s.review(taskId, "QA", { outcome: "FAIL", findings: [{ findingId: "qa-1", severity: "HIGH", observed: "Wrong output", expected: "Correct output" }] });
  s.review(taskId, "Architect", { outcome: "BLOCKED" });
  const result = s.diagnostics.explainReviews(taskId, observedAt);
  assert.deepEqual(result.findings.map(f => [f.code, f.condition]), [
    ["REVIEW_EVIDENCE_FAILED", "failed"], ["BLOCKING_FINDING_UNRESOLVED", "blocked"], ["REVIEW_EVIDENCE_BLOCKED", "blocked"], ["REVIEW_EVIDENCE_MISSING", "missing"],
  ]);
  assert.deepEqual(result.findings[1].references.findingIds, ["qa-1"]); assert.match(result.findings[0].message, /Recorded review reason/);
  assert.equal(result.findings[0].references.evidenceRef, `${reviewResultLineageId(taskId, "QA")}@1`);
  s.revisions.set(taskId, "next-commit"); const stale = s.diagnostics.explainReviews(taskId, observedAt);
  assert.deepEqual(stale.findings.map(f => f.condition), ["stale", "stale", "missing"]);
  assert.ok(stale.findings.every(f => f.code !== "BLOCKING_FINDING_UNRESOLVED"), "stale findings cannot claim current failure");
});
test("review latest lineage cannot resurrect superseded PASS and unknown revision is blocked", t => {
  const s = setup(t, [task(taskId, { requiredReviewRoles: ["Architect"] })]);
  s.review(); s.review(taskId, "Architect", { rev: "different-commit" });
  let result = s.diagnostics.explainReviews(taskId, observedAt);
  assert.equal(result.evidence[0].sequence, 2); assert.equal(result.findings[0].condition, "stale"); assert.match(result.findings[0].references.evidenceRef, /@2$/);
  s.revisions.clear(); result = s.diagnostics.explainReviews(taskId, observedAt);
  assert.deepEqual(result.findings.map(f => f.condition), ["missing", "blocked"]); assert.equal(result.evidence[0].currency, "UNKNOWN_REVISION");
});
test("a schema-valid recorded PASS cannot hide unresolved current blocking review findings", t => {
  const s = setup(t, [task(taskId, { requiredReviewRoles: ["Architect"] })]);
  s.review(taskId, "Architect", { findings: [
    { findingId: "architecture-high", severity: "HIGH", observed: "Consumer invariant fails", expected: "Preserve the invariant" },
    { findingId: "architecture-low", severity: "LOW", observed: "Minor wording issue", expected: "Clear wording" },
  ] });
  const result = s.diagnostics.explainReviews(taskId, observedAt);
  assert.equal(result.evidence[0].outcome, "PASS"); assert.equal(result.evidence[0].currency, "CURRENT"); assert.equal(result.clear, false);
  assert.deepEqual(result.findings.map(f => [f.code, f.condition]), [["PASS_WITH_BLOCKING_FINDINGS", "blocked"]]);
  assert.deepEqual(result.findings[0].references.findingIds, ["architecture-high"]);
  assert.equal(result.findings[0].references.evidenceRef, `${reviewResultLineageId(taskId, "Architect")}@1`);
  assert.match(result.findings[0].message, /Recorded PASS conflicts/);
  s.revisions.set(taskId, "new-commit");
  assert.deepEqual(s.diagnostics.explainReviews(taskId, observedAt).findings.map(f => f.condition), ["stale"]);
});
test("a task without independent reviews has a clear empty review scope", t => {
  const s = setup(t, [task(taskId, { requiredReviewRoles: ["Developer", "MergeController"] })]);
  const result = s.diagnostics.explainReviews(taskId, observedAt);
  assert.equal(result.clear, true); assert.deepEqual(result.evidence, []); assert.deepEqual(result.findings, []);
});
test("missing revision cannot invent an independent-review requirement on the no-review path", t => {
  const noReviews = setup(t, [task(taskId, { requiredReviewRoles: ["Developer", "MergeController"] })]);
  noReviews.revisions.clear();
  const empty = noReviews.diagnostics.explainReviews(taskId, observedAt);
  assert.equal(empty.revision, null); assert.equal(empty.clear, true); assert.deepEqual(empty.evidence, []); assert.deepEqual(empty.findings, []);
  assert.equal(empty.scope, "DECLARED_INDEPENDENT_REVIEW_EVIDENCE");
  const requiredReview = setup(t, [task(taskId, { requiredReviewRoles: ["QA"] })]);
  requiredReview.revisions.clear();
  const missing = requiredReview.diagnostics.explainReviews(taskId, observedAt);
  assert.equal(missing.clear, false); assert.deepEqual(missing.findings.map(f => f.code), ["REVISION_UNAVAILABLE", "REVIEW_EVIDENCE_MISSING"]);
  requiredReview.review(taskId, "QA");
  const unknownCurrency = requiredReview.diagnostics.explainReviews(taskId, observedAt);
  assert.equal(unknownCurrency.clear, false); assert.equal(unknownCurrency.evidence[0].currency, "UNKNOWN_REVISION");
  assert.deepEqual(unknownCurrency.findings.map(f => [f.code, f.condition]), [["REVISION_UNAVAILABLE", "missing"], ["REVIEW_EVIDENCE_BLOCKED", "blocked"]]);
});
test("merge diagnostics delegate exact policy and preserve changed PR head and failed CI reasons", async t => {
  const s = setup(t); s.setState(taskId, "MERGE_READY");
  const { engine, ciCalls, prCalls } = mergeEngine(s, { pr: { headSha: "changed-remote-head" }, checks: {
    [DEFAULT_REQUIRED_CI_CHECKS[0]]: [{ name: DEFAULT_REQUIRED_CI_CHECKS[0], status: "completed", conclusion: "failure", startedAt: observedAt }],
  } });
  const expected = await engine.evaluate({ taskId }); const result = await s.diagnostics.explainMerge(taskId, observedAt);
  assertEnvelope(result, "merge", "EXISTING_MERGE_READINESS_POLICY"); assert.deepEqual(result.merge, expected);
  assert.deepEqual(result.findings.map(f => f.code), expected.reasons.map(r => r.code));
  assert.deepEqual(result.findings.map(f => f.condition), ["failed", "stale"]);
  assert.equal(result.findings[0].references.checkContext, DEFAULT_REQUIRED_CI_CHECKS[0]);
  assert.equal(result.findings[1].references.revisionIdentity, "changed-remote-head");
  for (const f of result.findings) { assert.equal(f.references.expectedRevision, revision); assert.equal(f.references.pullRequestNumber, 77); }
  assert.ok(ciCalls.every(([ref]) => ref === revision)); assert.ok(prCalls.every(p => p.head === s.tasks[0].canonicalBranch && !Object.hasOwn(p, "base")));
});
test("missing CI, running CI, and failed CI stay distinct even when older success exists", async t => {
  const s = setup(t); s.setState(taskId, "MERGE_READY");
  const checks = { [DEFAULT_REQUIRED_CI_CHECKS[0]]: [], [DEFAULT_REQUIRED_CI_CHECKS[1]]: [
    { name: DEFAULT_REQUIRED_CI_CHECKS[1], status: "completed", conclusion: "success", startedAt: "2026-10-06T00:00:00Z" },
    { name: DEFAULT_REQUIRED_CI_CHECKS[1], status: "in_progress", conclusion: null, startedAt: observedAt },
  ] };
  mergeEngine(s, { checks }); const result = await s.diagnostics.explainMerge(taskId, observedAt);
  assert.deepEqual(result.findings.map(f => f.condition), ["missing", "blocked"]); assert.equal(result.clear, false);
});
test("merge policy preserves its exact-revision no-review path without manufacturing approvals", async t => {
  const s = setup(t, [task(taskId, { requiredReviewRoles: ["Developer", "MergeController"] })]);
  s.setState(taskId, "MERGE_READY"); mergeEngine(s, { roles: [
    { role: "Developer", approval: { status: "NONE" }, historyCount: 0 }, { role: "MergeController", approval: { status: "NONE" }, historyCount: 0 },
  ] });
  const before = s.snapshot(); const result = await s.diagnostics.explainMerge(taskId, observedAt);
  assert.equal(result.merge.ready, true); assert.equal(result.clear, true); assert.deepEqual(result.findings, []); assert.equal(s.snapshot(), before);
  assert.equal(result.state, "MERGE_READY"); assert.match(result.notes.join(" "), /BOOT-025 must recheck/);
});
test("unconfigured or unavailable merge providers produce blocked diagnostics, never synthetic readiness", async t => {
  const s = setup(t); let result = await s.diagnostics.explainMerge(taskId, observedAt);
  assert.equal(result.merge, null); assert.equal(result.clear, false); assert.equal(result.findings[0].code, "MERGE_PROVIDER_UNCONFIGURED");
  for (const code of ["PR_PROVIDER_FAILED", "CI_PROVIDER_FAILED", "EVIDENCE_UNAVAILABLE", "REVISION_CHANGED"]) {
    s.dependencies.mergeReadiness = { async evaluate() { throw new MergeReadinessError(code, `${code}: fixture unavailable`); } };
    result = await s.diagnostics.explainMerge(taskId, observedAt);
    assert.equal(result.merge, null); assert.equal(result.clear, false); assert.equal(result.findings[0].code, code);
    assert.equal(result.findings[0].condition, code === "REVISION_CHANGED" ? "stale" : "blocked");
  }
});
test("real merge policy provider failure is surfaced using its existing typed error", async t => {
  const s = setup(t); s.setState(taskId, "MERGE_READY"); mergeEngine(s, { ciError: new Error("CI read unavailable") });
  const result = await s.diagnostics.explainMerge(taskId, observedAt);
  assert.equal(result.clear, false); assert.equal(result.merge, null); assert.equal(result.findings[0].code, "CI_PROVIDER_FAILED");
  assert.match(result.findings[0].message, /CI read unavailable/);
});
test("merge explanation freezes a snapshot without freezing an injected policy result", async t => {
  const result = { taskId, revision, pullRequestNumber: 77, ready: false, reasons: [{ code: "BLOCKING_FINDINGS_UNRESOLVED", message: "Fix current finding", findingIds: ["finding-1"] }] };
  const s = setup(t, [task()], { mergeReadiness: { async evaluate(request) { assert.deepEqual(request, { taskId }); return result; } } });
  const before = structuredClone(result); const explanation = await s.diagnostics.explainMerge(taskId, observedAt);
  assert.deepEqual(result, before); assert.equal(Object.isFrozen(result), false); assert.equal(Object.isFrozen(result.reasons), false);
  assert.equal(Object.isFrozen(result.reasons[0].findingIds), false); assert.ok(Object.isFrozen(explanation.merge.reasons[0].findingIds));
});
test("merge diagnostics reject a mismatched revision or task and changes during the async observation", async t => {
  const s = setup(t);
  for (const change of [{ revision: "new-head" }, { taskId: "BOOT-999" }]) {
    s.dependencies.mergeReadiness = { async evaluate() { return { taskId, revision, pullRequestNumber: 77, ready: true, reasons: [], ...change }; } };
    await assert.rejects(() => s.diagnostics.explainMerge(taskId, observedAt), /changed during merge diagnostics/);
  }
  s.dependencies.mergeReadiness = { async evaluate() {
    s.setState(taskId, "BLOCKED"); return { taskId, revision, pullRequestNumber: 77, ready: true, reasons: [] };
  } };
  await assert.rejects(() => s.diagnostics.explainMerge(taskId, observedAt), /Local task facts changed/);
});
test("contradictory injected merge readiness results are rejected in both directions", async t => {
  const s = setup(t); const before = s.snapshot();
  for (const result of [
    { taskId, revision, pullRequestNumber: 77, ready: false, reasons: [] },
    { taskId, revision, pullRequestNumber: 77, ready: true, reasons: [{ code: "CI_CHECK_NOT_SUCCESSFUL", message: "CI failed" }] },
  ]) {
    s.dependencies.mergeReadiness = { async evaluate() { return result; } };
    await assert.rejects(() => s.diagnostics.explainMerge(taskId, observedAt), /contradicts its reasons/);
    assert.equal(s.snapshot(), before); assert.equal(Object.isFrozen(result), false);
  }
});
test("all explanation paths are deterministic and leave states, locks, evidence files and caller records unchanged", async t => {
  const s = setup(t); const state = s.setState(taskId, "DEV_VALIDATED"); s.validate(); s.review();
  const lock = { schemaId: "ipt.assignment-lock", schemaVersion: "1.1.0", taskId, canonicalBranch: s.tasks[0].canonicalBranch,
    status: "ACTIVE", lockId: "lock-1", ownerId: "developer", runId: "run-1", acquiredAt: observedAt };
  s.assignments.set(taskId, lock); const before = s.snapshot();
  const calls = [() => s.diagnostics.explainTask(taskId, observedAt), () => s.diagnostics.explainValidation(taskId, observedAt),
    () => s.diagnostics.explainReviews(taskId, observedAt), () => s.diagnostics.explainMerge(taskId, observedAt),
    () => s.diagnostics.explainTransition(transition(s.tasks[0], { expectedState: "DEV_VALIDATED", toState: "QA_REVIEW" }), observedAt)];
  for (const call of calls) {
    const result = await call(); assert.deepEqual(result, await call()); assert.equal(result.diagnosticsVersion, "1.0.0");
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.findings)); assert.equal(s.snapshot(), before);
  }
  assert.equal(Object.isFrozen(lock), false); assert.equal(Object.isFrozen(state), false); assert.equal(Object.isFrozen(state.history), false);
  assert.equal(Object.isFrozen(s.tasks[0]), false);
});
test("unknown tasks, invalid observations, corrupt evidence and changed snapshots fail closed", t => {
  const s = setup(t);
  assert.throws(() => s.diagnostics.explainTask("BOOT-999", observedAt), /not registered/);
  assert.throws(() => s.diagnostics.explainTask(taskId, "2026-02-30T00:00:00Z"), /valid RFC/);
  s.validate(); const original = s.source.evidence.getHistory;
  s.source.evidence.getHistory = id => original(id).map(r => ({ ...r, payload: { ...r.payload, outcome: "APPROVED" } }));
  assert.throws(() => s.diagnostics.explainValidation(taskId, observedAt), /Invalid persisted evidence/);
  s.source.evidence.getHistory = original;
  let read = 0; s.source.revisions.get = () => `revision-${read++}`;
  assert.throws(() => s.diagnostics.explainTask(taskId, observedAt), /changed while/);
});

test("merge dependency diagnostics do not invent cross-task revision equality", async t => {
  const s = setup(t, [task(taskId, { dependencies: ["BOOT-030"] }), task("BOOT-030")]);
  s.setState(taskId, "MERGE_READY"); s.setState("BOOT-030", "IN_DEVELOPMENT", "dependency-sha");
  mergeEngine(s);
  const result = await s.diagnostics.explainMerge(taskId, observedAt);
  const dependency = result.findings.find(f => f.code === "DEPENDENCY_NOT_SATISFIED");
  assert.equal(dependency.references.dependencyTaskId, "BOOT-030");
  assert.equal(dependency.references.revisionIdentity, "dependency-sha");
  assert.equal(Object.hasOwn(dependency.references, "expectedRevision"), false);
  assert.equal(result.revision, revision);
});
