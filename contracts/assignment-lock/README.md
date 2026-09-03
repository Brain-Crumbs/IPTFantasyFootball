# control-plane.assignment-lock

## Identity and purpose

- **Module ID:** `control-plane.assignment-lock`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

BOOT-010 owns explicit assignment identity and lock semantics for repository tasks. It prevents competing agents from both acquiring the same task while preserving deterministic conflict information and auditable release/recovery behavior.

## Structural contract

- `FileAssignmentLockStore(root)`
- `AssignmentLockStore.acquire(request): LockResult`
- `AssignmentLockStore.release(request): LockResult`
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
