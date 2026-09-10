# control-plane.assignment-lock

## Identity and purpose

- **Module ID:** `control-plane.assignment-lock`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

BOOT-010 owns explicit assignment identity and lock semantics for repository tasks. It prevents competing agents from both acquiring the same task while preserving deterministic conflict information and auditable release/recovery behavior.

## Structural contract

- `FileAssignmentLockStore(root)`
- `AssignmentLockStore.acquire(request): LockResult`
- `AssignmentLockStore.release(request): LockResult` — `request` accepts optional `expectedOwnerId`/`expectedRunId`/`expectedCanonicalBranch` compare-and-swap guards (BOOT-025), checked against the exact same record `release()` atomically claims before ever mutating it (see "Behavioral constraints and ranges" below) — never a separate, earlier read a concurrent operation could invalidate before the actual mutation runs. Omitting the optional fields preserves the original `lockId`-only match exactly.
- `AssignmentLockStore.recoverStale(request): LockResult`
- `AssignmentLockStore.get(taskId): AssignmentLockRecord | null`
- `AssignmentLockStore.getAudit(taskId): readonly LockAuditEvent[]`
- Durable lock records conform to `schemas/v1/assignment-lock.schema.json` v1.1.

## Capabilities

- Atomic single-winner task assignment using exclusive lock-file creation.
- Canonical task/branch binding.
- Idempotent reacquisition by the exact same active assignment identity.
- Deterministic conflict reporting without secret material.
- Explicit stale-lock recovery protected by an atomic recovery claim.
- Audited release and stale recovery.
- Collision-safe archival of released/stale records and recovery claims.
- Optional atomic full-identity compare-and-swap on release, closing the gap a `lockId`-only check leaves open when a caller's own separate, earlier full-identity check and the actual release call are not the same operation (a `lockId` reused by a later, differently-owned acquisition in between would otherwise still pass a `lockId`-only match).
- `release()` itself claims the active record via an atomic rename before ever inspecting or mutating it (mirroring `reclaimIfStale`'s own claim technique), rather than a plain read followed by a separate, later write: a bare read-then-write cannot rule out a concurrent `recoverStale()` replacing the assignment in between, which would otherwise let `release()` blindly overwrite (and then archive) that replacement — even a differently-owned one — using only the stale data its earlier read observed.
- That claiming rename still leaves the active path briefly absent while `release()` decides what to do with what it claimed. `release()` closes this by writing an exclusive reservation marker before the rename and holding it for its entire duration: `acquire()` checks for this marker exactly the way it already checks for an in-flight `recoverStale()` claim, rolling its own just-written record back if the marker is found, so an ordinary acquisition can never succeed while a still-genuinely-active assignment is only transiently absent because `release()` happens to be inspecting it.
- If the content `release()` claims away is unreadable or fails to parse, it is restored to the active path before the failure is rethrown — a caller normalizing the throw still finds an active assignment to retry against, not a task that falsely appears unassigned.
- A rename failure while claiming the active path is reported as `LOCK_NOT_FOUND` only for a genuinely absent lock (`ENOENT`); any other failure (permissions, a read-only filesystem, a transient I/O error) propagates instead, since a caller treating `LOCK_NOT_FOUND` as benign would otherwise skip release while the original assignment is still present on disk.
- `acquiredAt`/`expiresAt`/`occurredAt` accept a genuine RFC 3339 leap second (`23:59:60`) under any offset, checked against the UTC-equivalent instant rather than requiring the literal local digits to read `23:59` — consistent with `control-plane.controlled-merge`'s and `control-plane.evidence-store`'s own date-time validators. Every later comparison against an already-validated timestamp (`isStale`'s `expiresAt`-vs-now check, `expiresAt`-later-than-`acquiredAt`) goes through the same leap-second-substituted instant, not a raw `Date.parse` of the original string — `Date.parse` alone returns `NaN` for a leap second, which would otherwise make expiry ordering unenforceable and a leap-second `expiresAt` lock appear to never expire. A leap second (with any fractional part it may carry) maps to exactly 1ms before the following minute's own instant, computed from the whole-second `:59` form with any fraction discarded — not a flat `+1000ms` added on top of the substituted parse, which both collides exactly with the next minute for a fraction-less leap second and, for one carrying its own fraction (`:60.500`, say), can land the result *past* the next minute entirely. This system has no need to distinguish between two different leap-second instants down to the millisecond, only to place any leap second strictly between the `:59` second before it and the next minute.
- `release()`'s reservation marker and the record it claims away both use a fixed, well-known path once the reservation is held (not a randomized one — the reservation itself already guarantees exclusivity). If the process holding the reservation crashes before its own `finally` removes it, the marker (and, if the crash happened mid-claim, the orphaned record it was guarding) is not lost forever: once the marker is older than a fixed staleness threshold (mirroring `control-plane.controlled-merge`'s own abandoned-holder convention), `acquire()` or a later `release()` call reclaims it. That reclaim is itself atomic, not a plain stat-then-unlink: the marker is claimed via its own atomic rename first, and only the *captured* file's own re-checked age (rename preserves mtime) decides whether to proceed — restoring it untouched if it turns out to be a fresh marker a different, legitimately live `release()` call created in the gap between the initial staleness check and this claim, rather than stripping that live call of its own protection mid-flight. `acquire()`'s own check for an in-flight release also recognizes this claim's own temporary `.reclaim` marker, keeping that gap as narrow as an ordinary single ownership check. Once a claimed marker is confirmed genuinely stale, the orphaned record is restored to the active path via an exclusive-create write — never a plain `renameSync`, which POSIX silently allows to overwrite an existing destination file rather than fail — so a fresh, legitimately-created assignment that already occupies the active path is never clobbered by the orphan, re-entering the normal active/stale lifecycle rather than vanishing or leaving the task appearing falsely unassigned, before the stale marker itself is dropped.

## Behavioral constraints and ranges

- At most one active lock file exists for a task.
- `taskId` must match the repository task-ID format and `canonicalBranch` must equal the branch supplied from task metadata.
- `acquiredAt`, `expiresAt`, and release/recovery timestamps must be valid RFC 3339 date-times, consistent with the JSON Schema `date-time` contract.
- `expiresAt`, when supplied, must be later than `acquiredAt`.
- Expiry is evaluated before same-identity idempotency: an expired lock always requires explicit stale recovery.
- Ordinary acquisition never silently steals an expired lock.
- A stale recovery is bound to the exact stale lock ID and uses an exclusive recovery-claim file so two competing recovery attempts cannot both publish replacements.
- A matching recovery identity may resume an interrupted recovery claim; a competing recovery identity receives `LOCK_CONFLICT`.
- Archive destinations are generated collision-safely and may preserve repeated/reused lock IDs.
- `release()`'s optional `expectedOwnerId`/`expectedRunId`/`expectedCanonicalBranch` guards are each checked independently when supplied; any one mismatching the currently active record rejects the entire call as `LOCK_ID_MISMATCH` before any write, with no partial effect.
- A `release()` call whose identity check fails restores the claimed record to the active path exactly as observed, byte-for-byte, rather than leaving it lost, corrupted, or merely absent; if a third operation has since created its own fresh record at that path, the restore is skipped entirely (that operation's data is left untouched) rather than clobbering it.

## Invariants

- Two competing acquisition attempts for the same task cannot both succeed.
- A successful active assignment is bound to exactly one task, canonical branch, owner ID, run ID, and lock ID.
- A stale active assignment cannot be renewed by ordinary idempotent reacquisition.
- Explicit recovery cannot silently discard an active non-stale lock.
- A recovery contender that did not win the recovery claim cannot archive or replace the claimed assignment.
- Durable runtime records satisfy the assignment-lock schema's date-time requirements.
- Release/recovery history is preserved rather than deleted.

## Dependencies

### Allowed

- Node filesystem/path primitives used by the filesystem-backed adapter.
- `schemas/v1/assignment-lock.schema.json`.
- Task metadata supplying canonical task/branch identity.

### Forbidden

- Git branch creation or mutation.
- Next-task selection policy.
- Review/validation execution.
- Agent-provider-specific behavior.
- Fantasy-football product modules.

The lock manager consumes task identity but does not own task selection or branch lifecycle; BOOT-011 remains responsible for Git branch operations.

## Known consumers

### future-bootstrap-task-start-workflow

Why this consumer depends on the module:

- BOOT-013 must acquire assignment ownership before activating developer work.
- Later orchestration/status/recovery modules need stable assignment and audit semantics.

Required capabilities:

- atomic-single-winner-assignment
- canonical-branch-binding
- explicit-stale-recovery
- deterministic-conflicts
- auditable-release-recovery

## Consumer expectations and accepted ranges

### future-bootstrap-task-start-workflow

Expectations:

- Successful acquisition returns the exact active assignment identity.
- Same active identity can resume idempotently before expiry.
- Competing identity receives a structured deterministic rejection.
- Expired locks remain blocked until explicit recovery succeeds.

Accepted producer-output ranges:

- Success with `ACTIVE` lock plus `idempotent` flag.
- Structured rejection codes declared by `LockConflictCode`.
- Archived terminal records with `RELEASED` or `STALE` status.

Compatibility rule: the producer's reachable output range must remain within these states/results unless downstream consumers are updated and semantically reviewed.

## Consumer-required reachable ranges

### future-bootstrap-task-start-workflow

Required reachable producer-output ranges:

- Fresh acquisition success.
- Same-identity pre-expiry idempotent success.
- Competing-identity conflict.
- Expired-lock `LOCK_STALE` rejection.
- Explicit stale recovery success and competing-recovery conflict.
- Release followed by acquisition by a new identity.

Compatibility rule: all of these outcomes must remain reachable; preserving only the TypeScript shapes is insufficient.

## Examples

- Agent A acquires `BOOT-010`; Agent B receives `LOCK_CONFLICT` while A's lease is active.
- Agent A retries the same assignment before expiry and receives idempotent success.
- After expiry, even Agent A's ordinary retry receives `LOCK_STALE`; an operator must invoke explicit stale recovery.
- Two recovery attempts targeting the same stale lock compete for the same recovery claim; only the claim owner may archive and replace it.

## Edge cases

- Same identity retries after expiry: return `LOCK_STALE`, not idempotent success.
- A stale-recovery claim already owned by another actor/run: return `LOCK_CONFLICT` without touching the active assignment.
- Process interruption after a recovery claim: the same recovery identity can resume rather than silently abandoning ownership.
- Reusing a prior lock ID after release does not collide with archived history.
- Date-only strings such as `2026-09-03` are rejected even though `Date.parse` would accept them.
- Legacy/empty task directories do not wedge acquisition because the authoritative active lock is an atomically created task lock file.

## Change-impact checklist

For every proposed change, answer:

- [ ] Did a public interface/type/schema change?
- [ ] Did a capability disappear or become conditional?
- [ ] Did a behavioral range narrow or expand?
- [ ] Did an invariant change?
- [ ] Did an edge-case behavior change?
- [ ] Did dependency direction change?
- [ ] Is the producer reachable range still contained by each relevant consumer accepted range?
- [ ] Is each consumer-required reachable range still contained by the producer reachable range?

If structural compatibility remains but assignment/recovery semantics change, route the change through downstream Architecture semantic-compatibility review.
