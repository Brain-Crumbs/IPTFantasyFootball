# Evidence and Review Artifact Store

**Task:** BOOT-015 / issue #17
**Parent architecture:** issue #1
**Module ID:** `control-plane.evidence-store`

## Identity and purpose

`control-plane.evidence-store` persists auditable, revision-bound evidence so downstream gates can trust exact recorded artifacts rather than narrative claims ("I ran the tests"). It is the durable home for BOOT-014 `ValidationRunResult`/`ValidatorResult` output (`ipt.validation-evidence` records) and is built to the same record shape for future `ipt.review-result` artifacts (QA/Architect/UAT/Product/MergeController), without executing either.

The store does not run validators, does not execute reviews, and does not decide merge readiness. Those remain owned by BOOT-016 (developer validation gate) and the BOOT-017–BOOT-021 review pipeline.

## Structural contract

Primary API:

- `new FileEvidenceStore(root, options?: { repositoryRoot?: string })`
- `EvidenceStore.record(payload: unknown): RecordResult`
- `EvidenceStore.getCurrent(lineageId: string): StoredEvidenceRecord | null`
- `EvidenceStore.getHistory(lineageId: string): readonly StoredEvidenceRecord[]`
- `EvidenceStore.checkRevision(lineageId: string, expectedRevisionIdentity: string): RevisionCheckResult`
- `StoredEvidenceRecord { lineageId, sequence, status, storedAt, payload }`
- `validationEvidenceLineageId(taskId, validatorId)`, `reviewResultLineageId(taskId, role)`, `mergeEvidenceLineageId(taskId)` (BOOT-025)
- `EVIDENCE_STORE_SUPPORTED_SCHEMAS` — `{ "ipt.validation-evidence": "1.0.0", "ipt.review-result": "1.1.0", "ipt.merge-evidence": "1.0.0" }` (BOOT-017 added the optional `reviewerId`/`contextPackageId` fields as a backward-compatible minor bump; BOOT-025 added the third schema as a purely additive extension — no existing schema, lineage shape, or behavior changed)

`record()` accepts a raw JSON payload, not a pre-typed record: the store determines which of the three supported schemas applies from `payload.schemaId`, so callers do not need a separate "kind" argument.

## Schema-validated acceptance

Every `record()` call is validated against the exact `schemas/v1/validation-evidence.schema.json`, `schemas/v1/review-result.schema.json`, or `schemas/v1/merge-evidence.schema.json` document (resolved by `schemaId`, checked against the reader's one explicitly supported `schemaVersion`, per `schemas/VERSIONING.md` reader behavior) before anything is written. Validation covers the full JSON Schema subset those schemas use: `type`, `const`, `enum`, `minLength`, `pattern`, `format: date-time`, `minItems`, `uniqueItems`, `items`, object `properties`/`required`/`additionalProperties`, `$ref` into local `$defs` (used for role-specific `details` shapes, `finding`, and `nonPass`), and `allOf` entries expressed as `{ if, then }` role/outcome-conditioned fragments (used for role-specific `details` and the FAIL/BLOCKED → `nonPass` requirement). A malformed or schema-invalid payload is rejected with a structured `EvidenceRejection` and never persisted. BOOT-025 additionally extended the validator's supported subset with JSON Schema's `integer` type and the `minimum`/`maximum` numeric keywords (used by `ipt.merge-evidence`'s `pullRequestNumber: { type: "integer", minimum: 1 }`), so a fractional, zero, or negative pull-request number is rejected by the runtime store itself, not only by the Python `Draft202012Validator` `schemas/validate_fixtures.py` uses.

The validator's accept/reject behavior was cross-checked against the reference Python `jsonschema` `Draft202012Validator` (the same validator `schemas/validate_fixtures.py` uses) on every fixture in `schemas/fixtures/v1/` plus targeted edge cases (an unexpected property nested inside a `$ref`-resolved `details` shape, a `nonPass` missing `remediation`, an out-of-enum finding severity) and produced identical accept/reject results in every case.

## Revision binding and lineage

A record's identity for "what does this apply to" is a **lineage**, derived deterministically and never supplied separately by the caller:

- `ipt.validation-evidence` → `${taskId}::validator::${validatorId}`
- `ipt.review-result` → `${taskId}::role::${role}`
- `ipt.merge-evidence` → `${taskId}::merge`

Because the three forms differ, a validation-evidence, review-result, and merge-evidence record for the same `taskId` never collide. `checkRevision(lineageId, expectedRevisionIdentity)` returns exactly one of:

- `{ status: "CURRENT", record }` — the current record's `revisionIdentity` matches;
- `{ status: "REVISION_MISMATCH", record, expectedRevisionIdentity }` — a current record exists but for a different revision, so evidence can never be silently mistaken as applying to a commit it was not recorded against;
- `{ status: "NOT_FOUND" }` — no record exists yet for the lineage.

## Append-only persistence and current vs. superseded

Each accepted record is written to a new, zero-padded sequence file under its lineage directory (`<root>/<lineage>/0000001.json`, `0000002.json`, ...) using an exclusive create; no existing record file is ever overwritten, truncated, or deleted. `getHistory(lineageId)` returns every record in sequence order; `status` is computed at read time — the highest-sequence record is `CURRENT`, every earlier one is `SUPERSEDED` — so a superseded record remains fully queryable rather than erased. `getCurrent(lineageId)` returns only the current record, or `null` if the lineage has no evidence yet.

## No network required

Persistence is local-filesystem only (`node:fs`, `node:path`); `record()`/`getCurrent()`/`getHistory()`/`checkRevision()` are synchronous and require no network access, matching BOOT-014's no-network validation model and keeping the store deterministic and testable locally.

## Known consumers

- BOOT-016 (developer validation gate) persists BOOT-014's `ValidationRunResult`/`ValidatorResult` output as `ipt.validation-evidence` here and gates lifecycle advancement on the recorded, revision-checked outcome rather than an in-memory run result alone.
- BOOT-017 onward (QA/Architecture/UAT/Product/MergeController review) persists `ipt.review-result` records per task/role lineage here, and BOOT-021 (review rework/invalidation) uses `getHistory`/`checkRevision` to determine which prior approvals remain valid after a revision changes.
- BOOT-025 (controlled merge and completion transition) persists one `ipt.merge-evidence` record per task via `mergeEvidenceLineageId(taskId)` immediately after a merge is confirmed, and reads it back via `getCurrent` both to finish interrupted post-merge bookkeeping (task lifecycle `MERGED` but not yet `DONE`) and to answer a repeated call for a task already `DONE` idempotently, with no further writes.

## Out-of-scope follow-up

BOOT-015 deliberately does not execute validators or reviews, decide merge readiness, advance lifecycle state, or use any external/database storage. Those capabilities remain owned by later BOOT tasks in issue #1.
