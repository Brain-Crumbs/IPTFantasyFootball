# Recovery and administrative repair

**Task:** [BOOT-032 / issue #34](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/34)
**Architecture:** [issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)
**Contract:** [control-plane.recovery-tools](../contracts/recovery-tools/README.md)

## Authority and safety boundary

Recovery is an explicit, offline maintenance operation. It can release or transfer an assignment, remove an abandoned orchestration token, or route a task back to legal rework. It cannot approve a validator/reviewer, make a task merge-ready, merge, mark completion, discard history, or select another bootstrap issue. GitHub assignment and the manual bootstrap regime remain authoritative until explicit cutover.

Before any mutation, the operator must stop and independently verify all repository runners, direct workflow gates, external provider sessions, and other recovery processes. Set `confirmedQuiescent: true` only after that verification. Process age, an expired assignment, a missing local PID, or an interrupted client connection is not proof that a remote session or another writer stopped. The recovery mutex excludes other recoveries, not normal workflow writers; it is not a substitute for quiescence.

Administrative policy is separate from the request. The CLI trusts the host-configured comma-separated `IPT_RECOVERY_ADMIN_ACTORS` allowlist; an absent/empty list denies all overrides. Library hosts inject `LocalRecoveryOptions.authorizeOverride(request)`. The request's `override.authorizationRef` is mandatory audit context, never authorization by itself. This is an OS/operator trust boundary, not authentication: anyone able to modify the environment, code, or local state can impersonate an actor. Restrict account/filesystem/environment access externally. Do not put secrets in actor, reason, or authorization references.

## Commands and result meanings

```sh
npm run --silent agent -- --json recovery check
npm run --silent agent -- --json recovery apply ./recovery-request.json
```

`check` is read-only: it initializes no stores, runs no validators/providers, fetches no refs, and writes no state or audit. It returns `RecoveryCheckReport` with `recoveryVersion: "1.0.0"`, `checkedAt`, `consistent`, `findings`, and original `runs` identities. Findings include code, message, remediation and, where relevant, task/path. Reported inconsistencies are successful observations (exit 0), not permission to repair. `consistent: true` means no findings in this local scan; it proves neither quiescence nor remote PR/CI freshness, complete integrity, gate approval, or Bootstrap v1 completion.

The checker identifies representative malformed lifecycle/assignment/evidence/journal records, retained lifecycle gate mutexes, unregistered or unexpected state files, missing canonical branches, stale or missing assignments, illegal lifecycle history, missing/mismatched revision-bound evidence references, missing already-required validation/review evidence, pending runs, retained locks, and incomplete/malformed recovery audit pairs. A future required reviewer is not treated as an approval that should already exist. The scan can report multiple independent corrupt records rather than hiding later findings behind the first parse failure. Preserve originals when corruption is reported; the checker does not reconstruct them.

`apply` accepts one strict JSON request and returns `RecoveryResult` (`status: "APPLIED"`, operation ID, completion timestamp, intent hash, resulting hash or null, and intent audit path). This is the historical outcome of one recovery, not present workflow readiness. Exact completed retries return the stored outcome if the canonical branch still matches expectedRevision; later legitimate target-file changes do not rewrite that history, but a changed branch revision blocks replay. Invalid request/transport uses exit 2; expected recovery conflicts or denied overrides use exit 4; unexpected failures use exit 70. Both commands retain the CLI's `schemaVersion: "1.0.0"` envelope. The envelope command is `recovery`.

## Preconditions and request format

All operations require:

- A registered task and its exact existing canonical branch revision: `expectedRevision` is a lowercase full 40- or 64-character Git object ID, never a symbolic ref or abbreviated SHA.
- `expectedTargetHash`: lowercase SHA-256 of the exact UTF-8 target file contents, including whitespace/newline. Reformatting JSON changes this precondition.
- A unique `operationId` matching `[A-Za-z0-9][A-Za-z0-9_-]{0,79}`, a nonempty trimmed `actorId` and `reason`, `schemaVersion: "1.0.0"`, and explicit `confirmedQuiescent: true`.
- A valid existing lifecycle record and a supported target. The tool does not migrate legacy state or repair arbitrary malformed JSON, symlinks, absent records, or unknown task identities.

Only the documented fields are accepted. `replacement` is required only for `transfer-assignment`; `idempotencyKey` is required only for `release-run-lock`. Optional `expectedRecoveryLockHash` is only for resuming this same operation's retained recovery mutex as described below. Do not change a request's meaning under a reused operation ID.

Collect the revision from the task definition's exact canonical branch and hash the chosen target while all writers are stopped. For example, after verifying `BOOT-123` and its actual branch (the values below are illustrative):

```sh
git rev-parse --verify 'refs/heads/bootstrap/boot-123-example^{commit}'
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(readFileSync(process.argv[1], "utf8")).digest("hex"))' .agent/state/assignments/BOOT-123.lock.json
```

Inspect the original bytes and local lifecycle/evidence/journals; do not blindly refresh a mismatching hash and retry. A mismatch may mean a legitimate new owner or source revision superseded the intended repair.

## Recover a stale or abandoned assignment

The target is `.agent/state/assignments/<taskId>.lock.json`. Supported assignment targets are valid current-version (`1.1.0`) ACTIVE records on the registered canonical branch. An expired lease is stale; no expiry does not imply staleness. Ordinary stale release/transfer needs no administrative override, but still requires explicit request, exact hashes, audit, and quiescence. A non-stale assignment requires both `override.authorizationRef` and separately approved host policy.

Example request; replace the example task, exact revision/hash, actor, reason, and unique operation ID with inspected facts before applying:

```json
{
  "schemaVersion": "1.0.0",
  "operationId": "recover-boot123-assignment-01",
  "operation": "release-assignment",
  "taskId": "BOOT-123",
  "actorId": "operator-1",
  "reason": "Expired owner session is stopped; preserve unfinished work for reassignment.",
  "expectedRevision": "1111111111111111111111111111111111111111",
  "expectedTargetHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "confirmedQuiescent": true
}
```

For `transfer-assignment`, change `operation`, use a new operation ID, and add:

```json
{
  "replacement": {
    "lockId": "boot123-replacement-02",
    "ownerId": "replacement-developer",
    "runId": "replacement-run-02::developer-start",
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }
}
```

The replacement lock ID must differ from the current lock. Replacement owner/run must not already hold another registered task's ACTIVE assignment, because that would make Developer-start ownership ambiguous. Optional replacement expiry must be a canonical UTC millisecond timestamp strictly in the future at application time; the example date is not a recommendation. Omit expiry only if an intentionally non-expiring assignment is appropriate. Transfer preserves task/canonical branch, creates an ACTIVE assignment at the recovery timestamp, and records both old and new bytes. It does not transfer an existing orchestration journal to a new owner/run. For an orchestration run named replacement-run-02, the assignment runId must be replacement-run-02::developer-start, matching the engine's Developer-start stage identity; a direct standalone start uses its own supplied run ID.

Release removes only the active assignment target after saving its full prior contents. It does not return lifecycle to READY; a missing assignment may remain a checker finding until the authorized owning workflow/recovery establishes ownership. For abandoned in-progress work, transfer is usually the appropriate path because existing work still needs an assigned owner. Neither operation changes source, branches, validation/review evidence, or journals.

BOOT-032 audit records supplement assignment history. `AssignmentLockStore.getAudit()` alone does not include these offline operations. Audit consumers must inspect `.agent/state/recovery/*.intent.json` and matching results as well as the existing assignment audit/archive.

## Abandoned branch procedure

1. Identify the task's registered canonical branch and inspected exact revision, existing worktree edits, assignment owner/run, lifecycle, and run journals. Preserve source and evidence before changing ownership.
2. If the canonical branch exists at the expected revision, recover the assignment with this tool and continue using that same branch through the owning workflow. Branch existence is not ownership.
3. If the branch is missing, mismatched, has unknown local work, or a remote merge may have happened, stop the dependent repair and establish the authoritative revision through the branch/controlled-merge owner. `apply` refuses a missing or changed canonical revision.
4. Do not delete an abandoned branch, reset it to main, force-move a ref, discard worktree changes, or synthesize review evidence as recovery. BOOT-032 has no branch mutation command or automatic lost-branch reconstruction.

## Resume an interrupted run or review

Prefer ordinary BOOT-028 resume when the request/context/revision remain compatible. Never reset a task merely because a client disconnected.

1. Run `recovery check`, then inspect the actual lifecycle, current revision, immutable evidence, and the original journal (`.agent/state/orchestration/<sha256-of-idempotencyKey>.run.json`). `runs` exposes the original key, owner, run, and timestamp. Journal summaries do not establish that a gate passed.
2. Verify the original runner and external role session are stopped. If `.orchestration.lock` remains, use `release-run-lock` with its exact contents hash and the original journal's `idempotencyKey`. Keep task/revision/actor/reason/quiescence fields as above; omit `replacement`. The operation requires a valid original task-bound journal and never invents a run identity. There is no age/PID stealing.
3. Resume `SequentialOrchestrationEngine.run()` through the existing authorized library integration with the original `idempotencyKey`, `ownerId`, `runId`, and original `occurredAt`, using compatible role/permission/provider configuration. Generic `agent orchestrate` is still reserved.
4. Cached review output is reusable only for the exact task/role/revision/actor/context. An identical ReviewFramework submission reuses its original current evidence; changed or superseded payloads cannot be replayed. Lifecycle persistence already completed is not repeated. Durable attempt counts remain intact.
5. If the provider packet is still pending, use the existing BOOT-029 manual import/run procedure under that original identity. A terminal manual result is not editable; import alone does not advance a stopped orchestration engine.

For a direct review gate interruption, inspect whether evidence and lifecycle persistence completed, then use that gate's documented retry preconditions with the original exact payload. Do not call a later review gate merely because a provider reported PASS. A missing valid journal cannot be manufactured to unlock BOOT-028 recovery.

Pending `controlled-merge`, existing merge evidence, and `MERGED`/`DONE` require BOOT-025 reconciliation, never reset or assignment replacement to evade completion evidence. An abandoned orchestration token can be released only through the supported token-recovery preconditions before the original run resumes; the merge controller still owns every remote reconciliation and completion transition.

## Administrative reset and a genuinely new judgment

`reset-task` is for an authorized emergency return to development, including an interrupted review that cannot resume unchanged. Its target hash is the lifecycle file, not the assignment. It always requires a reason, an authorization reference, and host authorization. For example, add this field to a complete request with `operation: "reset-task"`:

```json
{ "override": { "authorizationRef": "maintainer-incident-123-approved-reset" } }
```

A trusted operator configures the CLI policy separately, for example `IPT_RECOVERY_ADMIN_ACTORS=operator-1`. This is not identity authentication. Merely adding `override` to JSON does not grant authority.

The reset uses the existing lifecycle transition engine: a supported nonterminal state goes through a legal `BLOCKED` transition and then `BLOCKED -> REWORK_REQUIRED`; an already BLOCKED task needs only the latter. Illegal source transitions are rejected. An already REWORK_REQUIRED task uses the existing resume gate instead. No reset accepts a requested destination or reaches a passed/merge/completed state. Prior lifecycle history is retained and new events link the recovery intent, actor, reason, timestamp, run, and exact revision.

Then:

1. Keep old journals, attempts, provider packets, and evidence unchanged.
2. Use `ReviewReworkGate.resumeDevelopment()` (BOOT-021) on the canonical branch for the exact reset revision to reach `IN_DEVELOPMENT`. The reset itself does not perform this step.
3. For a new review/implementation judgment, use a new orchestration run ID and key. Recover/transfer the existing assignment to the matching owner and assignment runId `${newOrchestrationRunId}::developer-start`, with a new lock ID before a new Developer start. A still-live/non-stale assignment needs the separately authorized override.
4. Invoke the existing pipeline with that matching new identity. Deterministic validation and every required independent review must run through their authoritative gates. Old PASS evidence at the same revision may still be reported CURRENT by currency queries, but reset has removed the lifecycle route to merge readiness; currency alone is not approval to skip the pipeline.

Same-identity resume and new-judgment rework are different operations. Never edit a cached review, delete a journal, reset its attempt counters, or rebind an old run ID to another key to obtain a fresh budget or replace a judgment.

## Audit durability and interrupted repair

Before touching the target, `apply` exclusively creates and flushes `.agent/state/recovery/<operationId>.intent.json`. The intent records the exact request, actor, reason, timestamp, revision, canonical branch, target path, full prior/resulting file contents (null means removal), override decision, and contextual lifecycle/assignment/run identities. A successful mutation is verified, then a separate immutable `<operationId>.result.json` is exclusively created and flushed, binding the intent and result hashes. Target replacement uses a same-directory temporary and atomic rename; directory flushes follow durable writes. No audit file is overwritten.

If a process crashes after intent persistence, absence of the result means an unverified outcome, not proof of no mutation. With all writers stopped, compare the target to the saved prior and resulting bytes, retain everything, and retry the exact original request. Only one of those two states is accepted; any third state is a conflict. Retrying a completed operation returns its original result rather than repeating the mutation, provided the canonical branch still matches the request's expectedRevision. A later target-file change is not a reason to rewrite that historical result.

A crash may retain `.agent/state/recovery/.recovery.lock`, including before an operation intent exists or after its final result was written. Inspect the mutex, original request, and any existing audit. Only the same original operation can resume it: the mutex binds operationId and requestHash (SHA-256 of the canonical key-sorted request, excluding expectedRecoveryLockHash). Supply the original request plus `expectedRecoveryLockHash` equal to SHA-256 of the inspected mutex contents and renewed quiescence confirmation. Before unlinking, recovery exclusively persists `<operationId>.<oldMutexSHA256>.mutex.json` with RELEASE_INTENT, actor/reason, timestamp/revision, full prior token and null resulting state. This record is an audited release intent, not by itself proof that unlink or repair completed. The pre-intent crash path can then plan the original operation; a post-result path can clear its token and return the original result.

The mutex hash is a compare-and-swap transport precondition, not a new operation identity. Do not remove the mutex based on age or PID, create a new operation to take it over, or reuse another operation's hash. An unbound/malformed mutex, corrupt audit, changed target, or changed branch requires investigation rather than automatic takeover. If interruption occurred after the inspected mutex was actually removed, re-inspect current files and retry the original request without the now-absent expectedRecoveryLockHash; do not pretend the missing token still exists.

After success, run `recovery check` and the relevant `status`/`explain` views again. Expected outstanding review/rework findings can remain; do not erase them to make the report green. Audit hashes detect inconsistencies, not a malicious privileged operator; retain protected backups of local operational records according to repository policy.

## Limits, migration, and rollback

- This is local/offline recovery, not a distributed transaction, authenticated admin service, remote side-effect detector, or automatic destructive repair system. Concurrent normal writers invalidate the quiescence assumption.
- The checker observes files without transaction isolation. An in-progress legitimate run can produce lock/pending findings; observation alone does not prove abandonment.
- Runtime recovery requests/audits have version `1.0.0`; existing task/lifecycle/assignment/evidence schemas are unchanged. Unsupported legacy/corrupt state is not migrated.
- No generic JSON editing, evidence deletion, history rewriting, Git force/reset/delete, provider-result replacement, remote merge undo, or arbitrary lifecycle destination is supplied.
- No automatic rollback deletes the intent/result or restores old ownership over a new owner. If a successful repair must be reversed, re-inspect current state and authorize a separate bounded operation with fresh identity/hash/reason; unsupported reversal needs the owning workflow and explicit investigation.
- Apply inspects the state tree with depth below 32 and fewer than 100,000 visited entries; larger trees fail closed and require investigation, not partial repair.
- Symlinked state paths are refused. Filesystem permissions and a trusted repository root remain required; the tool is not a hostile-filesystem sandbox.

## Acceptance and validation map

- Preconditions/unsafe repair: strict requests, registered canonical revision, exact target hash, explicit quiescence, live-lock override policy, legal lifecycle transitions, merge barriers, and conflicting/interrupted audit tests.
- Complete override audit: intent captures actor, reason, full prior/resulting bytes, timestamp/revision/context and authorization reference; result binds hashes and completion. Inspect both files in the emergency-override fixture.
- History preservation: tests compare retained lifecycle history, evidence, journals and attempts; direct assignment recovery retains prior bytes in supplemental audit.
- Stale recovery without false success: expired release/transfer changes only assignment ownership; active/non-stale unauthorised attempts fail; reset can only end in REWORK_REQUIRED.
- Consistency before repair: checker fixtures cover corrupt/incomplete records and mismatched evidence, plus non-mutating byte/tree comparisons.
- Interrupted review: existing BOOT-028 exact-input resume is exercised with original identities; new-judgment reset/transfer keeps older lineage and reaches fresh authoritative review gates.

Run the repository checks and focused recovery coverage from a clean dependency installation:

```sh
npm run build
npm test
python3 schemas/validate_fixtures.py
python3 schemas/validate_repository_contracts.py
```

The PR must report exact executed results and fixture evidence; this mapping is not a claim of independent QA/Architecture/UAT approval. Local behavior, lifecycle correctness, and downstream consumer semantics all require review.
