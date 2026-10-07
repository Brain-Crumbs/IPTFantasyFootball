# Generic Review Framework and Structured Findings

**Tasks:** BOOT-017 / issue #19; BOOT-028 / issue #30
**Parent architecture:** issue #1
**Module ID:** `control-plane.review-framework`
**Module version:** `2.0.0`
**Manifest:** `./module-contract.json`

## Identity and purpose

`control-plane.review-framework` is the role-independent review substrate used by the Developer's own structured handoff and by the QA, Architecture, and UAT/Product review workflows (BOOT-018 through BOOT-020). It defines no role-specific judgment logic of its own: a caller has already decided a PASS/FAIL/BLOCKED outcome and structured findings for one role; the framework's job is to bind that judgment to the exact task/revision/context package under review, enforce the cross-role invariants in `docs/ROLE_MODEL.md`, and persist the result through the unmodified BOOT-015 evidence store so distinct attempts remain separately auditable and exact retries do not append duplicate records.

The framework does not run QA/Architecture/UAT logic, does not invoke an agent provider, and does not compute merge readiness or mutate lifecycle state. Those remain owned by BOOT-018 through BOOT-025.

## Structural contract

Primary API:

- `new ReviewFramework(dependencies)`
- `ReviewFrameworkEvidenceStore { record, validate, getHistory, getCurrent, checkRevision }` — all five operations are required; `validate` checks payload schema without writing and `getHistory` exposes the complete role lineage.
- `ReviewFramework.submit(request: ReviewSubmissionRequest): ReviewSubmissionResult`
- `ReviewSubmissionRequest { taskId, role, revisionIdentity, reviewerId, runId, contextPackage, outcome, details, findings, evidenceRefs, nonPass?, occurredAt }` — the review invocation envelope: `role` is one of the five `docs/ROLE_MODEL.md` roles, `reviewerId` identifies the actor/session issuing the judgment, and `contextPackage` is the exact BOOT-012 `ContextPackage` the reviewer was handed.
- `ReviewFinding { findingId, severity, observed, expected, requirementRef?, contractRef?, evidenceRef?, remediation? }`
- `FINDING_SEVERITIES` — `["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]`
- `BLOCKING_FINDING_SEVERITIES` — `["MEDIUM", "HIGH", "CRITICAL"]`; `isBlockingSeverity(severity)`, `blockingFindings(findings)`
- `computeContextPackageId(contextPackage): string` — deterministic SHA-256 content identity of a context package
- `ReviewSubmissionResult { reviewId, taskId, role, outcome, revisionIdentity, contextPackageId, blockingFindings, evidenceLineageId, evidenceSequence, recordedAt, evidenceLocation }`
- `ReviewFrameworkError` — structured failure with a stable `code`, including `REVIEW_ID_CONFLICT` for changed content under an existing identity and `EVIDENCE_REJECTED` for invalid or superseded evidence
- `createLocalReviewFramework(repositoryRoot?)` — local composition root, mirroring BOOT-016's `createLocalDeveloperValidationGate`

`agent review` remains reserved (BOOT-018 through BOOT-021 own the CLI entry points and role-specific context/finding generation that will call this framework); BOOT-017 ships the library boundary those commands compose over.

## Review invocation envelope and revision/context binding

Every submission must identify, in the request itself: `taskId`, `role`, the exact `revisionIdentity` under review, the `reviewerId` issuing the judgment, a `runId` disambiguating repeated attempts, and the exact `contextPackage` the reviewer was compiled from. `submit()` rejects, as `CONTEXT_PACKAGE_MISMATCH`, a `contextPackage` whose `taskId`, `role`, or `sourceRevision` does not match the request — a reviewer can never be recorded as having judged a task/role/revision other than the one its own compiled context package was bound to. The persisted record additionally carries `contextPackageId`, a deterministic SHA-256 content hash (`computeContextPackageId`) of the entire context package: two packages sharing role/task/revision but compiled from a different artifact catalog (a requirement or contract changed upstream since compilation) never collide on the same identity, so "the exact context package the reviewer saw" is itself part of the auditable record, not just the exact revision.

## Blocking findings and the PASS contradiction rule

Every `ReviewFinding` carries a `severity`. `MEDIUM`, `HIGH`, and `CRITICAL` are framework policy blocking severities (`BLOCKING_FINDING_SEVERITIES`); `INFO` and `LOW` remain non-blocking observations. This threshold is owned here, once, so BOOT-018/019/020 never redefine what "blocking" means for their own role. `submit()` rejects, as `PASS_WITH_BLOCKING_FINDINGS`, any submission that reports `outcome: "PASS"` while `findings` still contains an unresolved blocking-severity item — a role can never report PASS "with reservations" while leaving a MEDIUM+ finding open. This is deliberately enforced as a business rule inside the framework rather than by narrowing the already-versioned `schemas/v1/review-result.schema.json` document, consistent with BOOT-016 not widening an earlier-merged schema. A `FAIL`/`BLOCKED` outcome without a `nonPass` reason/remediation is rejected as `NON_PASS_MISSING_DETAIL` before the framework ever reaches the evidence store's own schema-level version of the same rule.

## Independent-review gating and no-self-approval

`docs/ROLE_MODEL.md` section 1 invariant 1 states an implementation's own session may record Developer self-validation but may never issue QA/Architecture/UAT/Product/MergeController approval for that same implementation. `submit()` enforces this mechanically for every role other than `Developer`:

1. it reads the task's current `Developer` review-result record (`reviewResultLineageId(taskId, "Developer")`) through the evidence store;
2. a missing record is rejected as `DEVELOPER_HANDOFF_MISSING` — independent review cannot begin before a Developer handoff exists;
3. a record bound to a different revision than this submission is rejected as `DEVELOPER_HANDOFF_REVISION_MISMATCH` — this operationalizes BOOT-016's known-consumer expectation that independent review only evaluates a revision that has already passed developer validation;
4. a record whose `outcome` is not `PASS` is rejected as `DEVELOPER_HANDOFF_NOT_PASSED`;
5. a record whose `reviewerId` equals the current submission's `reviewerId` is rejected as `SELF_APPROVAL_REJECTED` — the same actor/session that produced the Developer handoff for this exact revision may not also issue the independent judgment for it.

## Revision-bound, append-only persistence

A logical review identity is `${taskId}:${role}:${revisionIdentity}:${runId}`. A fresh identity is schema-validated and appended as an `ipt.review-result` record through the unchanged BOOT-015 store, under `reviewResultLineageId(taskId, role)`. Before writing, `submit()` searches the complete lineage history for that identity:

- No match: append a new record.
- One match with the identical canonical payload: reuse its original evidence sequence only if an independent `checkRevision` confirms that exact sequence/payload is still `CURRENT` for the requested revision. All fields, including `reviewerId`, context content hash, details, findings, references, and `occurredAt`, are part of payload equality; property ordering is not.
- One match with changed content: reject as `REVIEW_ID_CONFLICT`; use a new `runId` for an intentional new judgment.
- A superseded identity, invalid stored record, multiple records with the same identity, or a readback returning a different current review: reject as `EVIDENCE_REJECTED`. An old PASS must never be appended again over a newer FAIL, even at the same source revision.

The framework validates the incoming payload, the current Developer handoff, and any reused/read-back record through the injected evidence store. It checks lineage and positive safe-integer sequence, verifies current Developer task/role/reviewer identity, and retains all revision/context/self-approval/PASS-with-blocking-finding rules. Revision equality alone is insufficient evidence of an exact retry.

A genuine new attempt uses a distinct run identity and appends a new sequence; prior records stay readable as `SUPERSEDED`. An exact retry appends nothing and returns its original evidence reference. Callers must therefore retain the complete accepted payload, especially the original timestamp, instead of regenerating it on recovery.

## BOOT-028 compatibility and migration

Module `2.0.0` adds required `validate` and `getHistory` methods to `ReviewFrameworkEvidenceStore`; custom stores/test doubles must implement them faithfully. Existing `FileEvidenceStore` already exposes both and needs no schema migration. The evidence schema remains `ipt.review-result` `1.1.0`; the module version bump reflects the injected port and changed duplicate-submission behavior, not a stored-schema bump.

QA/Architecture/UAT gates and Developer handoff producers must distinguish an exact retry from a new attempt. BOOT-028 orchestration caches provider results and submits the original run identity/timestamp so an interrupted gate can reuse current evidence. BOOT-021 rework still sees every distinct review attempt and supersession; it must not require another record for an identical retry. Existing duplicate historical identities or malformed legacy handoffs fail closed and are not rewritten or repaired automatically.

This read-check-write protocol is not a distributed compare-and-swap store. Callers retain their existing per-task gate exclusion; orchestration adds repository-wide run exclusion. The framework does not claim safe arbitrary concurrent standalone submissions across writers that bypass those locks.

## Schema change: `ipt.review-result` 1.0.0 → 1.1.0

BOOT-015 defined `schemas/v1/review-result.schema.json` without a real consumer. BOOT-017 is its first consumer and needs to persist `reviewerId` (for self-approval detection) and `contextPackageId` (for context-identity binding) on every record. Both are added as new, optional, top-level string properties — a backward-compatible minor bump per `schemas/VERSIONING.md` ("adding an optional field... must not invalidate a previously valid record"). `EVIDENCE_STORE_SUPPORTED_SCHEMAS["ipt.review-result"]` and the `schemas/fixtures/v1/review-result.*.json` fixtures were updated to `1.1.0` alongside the schema; `schemas/validate_fixtures.py` still passes.

## Known consumers

- BOOT-018 (QA review workflow), BOOT-019 (Architecture review), and BOOT-020 (UAT/Product review) will compute their own role-specific outcome/findings/details and call `submit()` to persist and bind the result, inheriting the blocking-findings, self-approval, and revision/context-binding rules for free.
- BOOT-021 (review rework and approval invalidation loop) will use `getHistory`/`checkRevision` on the same `ipt.review-result` lineages to decide which prior approvals remain valid after a revision changes.
- A future Developer-handoff caller (composed alongside or after BOOT-016's deterministic validation gate) will call `submit()` with `role: "Developer"` to record the structured handoff (`implementationSummary`, `changedSurfaces`, etc.) that independent review is gated on.

## Out-of-scope follow-up

BOOT-017 deliberately does not implement QA/Architecture/UAT/Product review logic, does not invoke an AI provider, does not compute merge readiness, and does not transition lifecycle state (it has no BOOT-009 dependency). Those remain owned by later BOOT tasks in issue #1.
