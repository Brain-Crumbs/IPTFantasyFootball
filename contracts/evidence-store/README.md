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
- `validationEvidenceLineageId(taskId, validatorId)`, `reviewResultLineageId(taskId, role)`
- `EVIDENCE_STORE_SUPPORTED_SCHEMAS` — `{ "ipt.validation-evidence": "1.0.0", "ipt.review-result": "1.1.0" }` (BOOT-017 added the optional `reviewerId`/`contextPackageId` fields as a backward-compatible minor bump)

`record()` accepts a raw JSON payload, not a pre-typed record: the store determines which of the two supported schemas applies from `payload.schemaId`, so callers do not need a separate "kind" argument.

## Schema-validated acceptance

Every `record()` call is validated against the exact `schemas/v1/validation-evidence.schema.json` or `schemas/v1/review-result.schema.json` document (resolved by `schemaId`, checked against the reader's one explicitly supported `schemaVersion`, per `schemas/VERSIONING.md` reader behavior) before anything is written. Validation covers the full JSON Schema subset those two schemas use: `type`, `const`, `enum`, `minLength`, `pattern`, `format: date-time`, `minItems`, `uniqueItems`, `items`, object `properties`/`required`/`additionalProperties`, `$ref` into local `$defs` (used for role-specific `details` shapes, `finding`, and `nonPass`), and `allOf` entries expressed as `{ if, then }` role/outcome-conditioned fragments (used for role-specific `details` and the FAIL/BLOCKED → `nonPass` requirement). A malformed or schema-invalid payload is rejected with a structured `EvidenceRejection` and never persisted.

The validator's accept/reject behavior was cross-checked against the reference Python `jsonschema` `Draft202012Validator` (the same validator `schemas/validate_fixtures.py` uses) on every fixture in `schemas/fixtures/v1/` plus targeted edge cases (an unexpected property nested inside a `$ref`-resolved `details` shape, a `nonPass` missing `remediation`, an out-of-enum finding severity) and produced identical accept/reject results in every case.

## Revision binding and lineage

A record's identity for "what does this apply to" is a **lineage**, derived deterministically and never supplied separately by the caller:

- `ipt.validation-evidence` → `${taskId}::validator::${validatorId}`
- `ipt.review-result` → `${taskId}::role::${role}`

Because the two forms differ, a validation-evidence record and a review-result record for the same `taskId` never collide. `checkRevision(lineageId, expectedRevisionIdentity)` returns exactly one of:

- `{ status: "CURRENT", record }` — the current record's `revisionIdentity` matches;
- `{ status: "REVISION_MISMATCH", record, expectedRevisionIdentity }` — a current record exists but for a different revision, so evidence can never be silently mistaken as applying to a commit it was not recorded against;
- `{ status: "NOT_FOUND" }` — no record exists yet for the lineage.

## Append-only persistence and current vs. superseded

Each accepted record is written to a new, zero-padded sequence file under its lineage directory (`<root>/<lineage>/0000001.json`, `0000002.json`, ...) using an exclusive create; no existing record file is ever overwritten, truncated, or deleted. `getHistory(lineageId)` returns every record in sequence order; `status` is computed at read time — the highest-sequence record is `CURRENT`, every earlier one is `SUPERSEDED` — so a superseded record remains fully queryable rather than erased. `getCurrent(lineageId)` returns only the current record, or `null` if the lineage has no evidence yet.

## No network required

Persistence is local-filesystem only (`node:fs`, `node:path`); `record()`/`getCurrent()`/`getHistory()`/`checkRevision()` are synchronous and require no network access, matching BOOT-014's no-network validation model and keeping the store deterministic and testable locally.

## Known consumers

- BOOT-016 (developer validation gate) will persist BOOT-014's `ValidationRunResult`/`ValidatorResult` output as `ipt.validation-evidence` here and gate lifecycle advancement on the recorded, revision-checked outcome rather than an in-memory run result alone.
- BOOT-017 onward (QA/Architecture/UAT/Product/MergeController review) will persist `ipt.review-result` records per task/role lineage here, and BOOT-021 (review rework/invalidation) can use `getHistory`/`checkRevision` to determine which prior approvals remain valid after a revision changes.

## Out-of-scope follow-up

BOOT-015 deliberately does not execute validators or reviews, decide merge readiness, advance lifecycle state, or use any external/database storage. Those capabilities remain owned by later BOOT tasks in issue #1.
