# Assignment Lock Manager

## Capability

BOOT-010 provides explicit assignment ownership for a task. The manager persists one active lock per task and uses atomic directory creation as the compare-and-set boundary, so competing acquisition attempts cannot both succeed.

Each v1.1 lock binds `taskId`, `canonicalBranch`, `ownerId`, `runId`, `lockId`, acquisition time, status, and optional expiry. The caller must supply the canonical branch from task metadata; a mismatched task/branch request is rejected before acquisition.

## Idempotency

Re-acquisition succeeds idempotently only when lock ID, owner ID, run ID, task ID, and canonical branch match the current active assignment. A different identity receives a deterministic conflict containing only assignment identifiers required for recovery/diagnostics.

## Stale-lock policy

Expiry is a lease signal, not permission to steal work. Once `expiresAt` is reached, ordinary acquisition returns `LOCK_STALE`; it never deletes, replaces, or silently adopts the existing lock. Recovery requires an explicit `recoverStale` request that names the exact stale lock ID and records a recovery actor, recovery run, timestamp, and non-empty reason. An active, non-expired lock cannot be recovered through this path.

The recovered stale record is archived before a replacement acquisition is attempted. If another contender wins the replacement race, the contender receives the normal deterministic conflict; at most one active assignment exists.

## Release and audit history

Release requires the exact active lock ID plus actor, run, timestamp, and reason. Released and stale records are moved under the lock store's `.history` directory rather than deleted. Append-only JSON-lines audit records capture acquisition, idempotent re-acquisition, release, and stale recovery actions. `getAudit(taskId)` combines current and archived events in timestamp order.

## Boundaries

This module does not choose the next task, create Git branches, or implement general administrative repair. BOOT-011 owns branch lifecycle operations; later recovery tooling may wrap the explicit stale-recovery primitive without weakening its preconditions.
