import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileAssignmentLockStore, type AssignmentLockRecord, type LockResult } from "../assignment-lock/index.js";
import { LOCAL_AGENT_STATE_RELATIVE_PATH } from "../dev-start/index.js";
import {
  FileEvidenceStore,
  mergeEvidenceLineageId,
  type RecordResult,
  type StoredEvidenceRecord,
  type ValidateResult,
} from "../evidence-store/index.js";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
  type TaskBranchMetadata,
} from "../git-branch-lifecycle/index.js";
import {
  createLifecycleRecord,
  transitionLifecycle,
  type LifecycleHistoryEvent,
  type LifecycleRecord,
  type ReviewRole,
} from "../lifecycle/index.js";
import {
  createLocalMergeReadinessPolicyEngine,
  type EvaluateMergeReadinessResult,
  type FetchLike,
} from "../merge-readiness/index.js";
import { PullRequestProviderError } from "../pr-lifecycle/index.js";
import {
  TASK_LIFECYCLE_STATES,
  loadTaskRegistry,
  type RegisteredTask,
  type TaskLifecycleState,
  type TaskRegistry,
} from "../task-registry/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_INTEGRATION_TARGET = "main";

// A lock file older than this is treated as abandoned (its holder crashed or
// was killed mid-merge) and is reclaimed by the next caller rather than
// wedging the task indefinitely. Matches BOOT-018's/BOOT-019's/BOOT-020's/
// BOOT-021's own task-lock thresholds.
const STALE_LOCK_MS = 5 * 60 * 1000;

// The held lock's timestamp is refreshed this often while `fn` is running,
// well inside STALE_LOCK_MS, so a merge() call whose readiness/provider
// calls legitimately run long is never mistaken for an abandoned holder and
// reclaimed by a concurrent caller out from under it.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * BOOT-025 controlled merge and completion transition — the only supported
 * path that merges a task's merge-ready pull request, verifies the merged
 * revision, finalizes audit evidence, releases the assignment lock, and
 * transitions the task MERGE_READY -> MERGED -> DONE.
 *
 * `merge()` never trusts an in-memory "it was ready a moment ago" claim: it
 * recomputes BOOT-024 merge readiness itself immediately before merging, then
 * re-reads the pull request's actual remote head one more time immediately
 * before invoking the merge provider, so a push landing in either gap is
 * rejected as HEAD_CHANGED rather than merging code nobody approved. Every
 * step after the merge provider call is resumable: a process that crashes
 * before the provider call leaves the task MERGE_READY with nothing merged
 * (safe to retry); a crash after a confirmed provider merge but before local
 * bookkeeping persists is resumed by re-reading the pull request's own
 * `merged`/`mergeCommitSha` fact from the provider rather than ever calling
 * the merge endpoint a second time; a crash after the MERGED lifecycle write
 * but before lock release/DONE finishes local-only bookkeeping with no
 * provider call at all; and a task already DONE returns its persisted
 * evidence idempotently with no further writes.
 */
export class ControlledMergeController {
  constructor(private readonly dependencies: ControlledMergeDependencies) {}

  async merge(request: ControlledMergeRequest): Promise<ControlledMergeResult> {
    validateRequest(request);

    const task = this.dependencies.registry.get(request.taskId);
    if (task === undefined) {
      throw new ControlledMergeError("TASK_NOT_FOUND", `Task '${request.taskId}' is not registered.`, false);
    }

    // The DONE path is a pure, side-effect-free read: it never needs the
    // exclusive task lock, so it can never be blocked by lock contention (a
    // concurrent in-progress attempt, or an abandoned-but-not-yet-stale lock
    // file) from returning already-persisted evidence — checked here,
    // before the lock is ever acquired.
    const precheck = this.dependencies.stateStore.get(task.taskId);
    if (precheck !== null && precheck.currentState === "DONE") {
      return this.finishedResult(precheck);
    }

    // Holds the lock across the entire read-decide-write critical section,
    // including the async provider calls below, so two concurrent merge()
    // calls for the same task can never interleave their reads and writes
    // (mirrors BOOT-018's/BOOT-019's/BOOT-020's/BOOT-021's own task locks).
    // `assertHeld` is a fencing check the lock hands back: it is called
    // immediately before every side-effecting operation below (the merge
    // provider call, evidence recording, each lifecycle-state save), so a
    // holder that has lost the lock to a concurrent reclaim (its own
    // heartbeat having lapsed past the stale threshold) aborts at the next
    // checkpoint rather than silently completing writes alongside a second,
    // legitimate holder.
    return this.dependencies.taskLock.withLock(task.taskId, (assertHeld) => this.mergeLocked(task, request, assertHeld));
  }

  private async mergeLocked(
    task: RegisteredTask,
    request: ControlledMergeRequest,
    assertHeld: () => void,
  ): Promise<ControlledMergeResult> {
    // Re-read inside the lock: the unlocked pre-check above cannot see a
    // concurrent caller that reaches DONE between that check and this
    // caller acquiring the lock.
    const record = this.dependencies.stateStore.get(task.taskId) ?? createLifecycleRecord(task.taskId);

    if (record.currentState === "DONE") {
      return this.finishedResult(record);
    }

    if (record.currentState === "MERGED") {
      // Never snapshot the assignment lock here: whatever happens to be
      // active *now* may belong to an entirely different, later assignment
      // than the one that actually performed this confirmed merge — the
      // original attempt may have crashed, been recovered, and reassigned
      // before this resume call ever ran. Only the identity persisted
      // alongside the original merge's own evidence (assignmentLockAtMerge)
      // is ever eligible for release on this path — see resumeBookkeeping.
      return this.resumeBookkeeping(task, record, request, assertHeld);
    }

    if (record.currentState !== "MERGE_READY") {
      throw new ControlledMergeError(
        "TASK_STATE_NOT_MERGEABLE",
        `Task '${task.taskId}' is in lifecycle state '${record.currentState}' and cannot be merged; it must be MERGE_READY.`,
      );
    }

    // Captured once, before any provider call, so completion only ever
    // releases the exact assignment identity this call observed at entry —
    // never a lock some other actor has since legitimately reacquired. The
    // assignment-lock contract does not guarantee lockId is never reused
    // across acquisitions, so the full identity (lockId, ownerId, runId,
    // canonicalBranch) is captured and later compared in full, not lockId
    // alone. A read failure here (I/O error, malformed lock file) is
    // normalized the same way the completion-time re-read is, rather than
    // escaping as a raw exception.
    let lockSnapshot: AssignmentLockRecord | null;
    try {
      lockSnapshot = this.dependencies.lockStore.get(task.taskId);
    } catch (error: unknown) {
      throw new ControlledMergeError(
        "LOCK_RELEASE_FAILED",
        `Task '${task.taskId}' assignment lock could not be read at merge entry: ${detail(error)}`,
        true,
      );
    }
    const lockIdentityToRelease: LockIdentity | null =
      lockSnapshot !== null && lockSnapshot.status === "ACTIVE"
        ? {
            lockId: lockSnapshot.lockId,
            ownerId: lockSnapshot.ownerId,
            runId: lockSnapshot.runId,
            canonicalBranch: lockSnapshot.canonicalBranch,
          }
        : null;

    let revision: string;
    try {
      this.dependencies.branchLifecycle.assertCurrentTaskBranch(task);
      revision = this.dependencies.branchLifecycle.currentRevision();
    } catch (error: unknown) {
      throw normalizeBranchError(task.taskId, error);
    }
    const head = this.dependencies.branchLifecycle.canonicalBranch(task);
    const integrationTarget = this.dependencies.integrationTarget ?? DEFAULT_INTEGRATION_TARGET;

    // Searches every pull request for this branch, in any state — not only
    // the single most-recent one — so a stray, unrelated PR (for example a
    // closed one against a different base, created more recently than the
    // genuinely approved one) can never hide the actual merged PR this task
    // approved: if this exact process's own prior attempt already merged
    // it and then crashed before recording evidence, that merged PR must
    // still be found here even when it is no longer the most-recent PR for
    // the branch.
    const candidates = await this.findPullRequests(task.taskId, head);
    // The search key is the revision this task's own MERGE_READY transition
    // actually approved — never the branch's *current* head. A confirmed
    // merge can be followed by a completely unrelated push to the same
    // branch before evidence is ever recorded (a crash between the
    // provider's own merge call and this controller's bookkeeping); in that
    // window, `revision` (freshly resolved from the live branch) no longer
    // matches the merged PR's headSha at all, and since that PR is now
    // merged and closed, the normal readiness-evaluate path below cannot
    // recover it either (evaluate() only ever considers open pull
    // requests) — permanently stranding an already-successful merge in
    // MERGE_READY. The approved revision, by contrast, is exactly what the
    // MERGE_READY lifecycle-history event bound at approval time and never
    // changes after the fact, so searching by it finds the confirmed merge
    // regardless of anything that has happened to the branch since.
    const approvedRevision = latestHistoryEventToState(record, "MERGE_READY")?.revisionIdentity ?? null;
    // The highest-numbered matching candidate, not merely the first one
    // find() encounters: ControlledMergePullRequestPort makes no promise
    // about candidate ordering, so if both a historical, reverted PR and
    // the actual newer approval also happen to report merged=true (the
    // ordinary "confirmed prior attempt" case this shortcut exists for, not
    // only the adversarial reused-SHA scenario below), an adapter that
    // simply returns the older one first would otherwise select it over the
    // genuinely current, correct match sitting later in the array.
    const matched =
      approvedRevision !== null
        ? candidates.reduce<ControlledMergePullRequestRecord | null>((best, pr) => {
            if (!(pr.merged && pr.headSha === approvedRevision && pr.baseRef === integrationTarget)) return best;
            return best === null || pr.number > best.number ? pr : best;
          }, null)
        : null;
    // A merged, revision-and-base-matching candidate is not automatically
    // proof of *this* attempt's confirmed merge: if the canonical branch and
    // source SHA are ever reused after an earlier PR against the same base
    // was squash-merged and later reverted on the integration target, that
    // historical PR's own record still (correctly, historically) reports
    // merged=true at the same headSha/baseRef, even while the task's actual,
    // current pull request for this approval has not merged at all — whether
    // it is still open, or has since been closed without merging (rejected,
    // superseded, abandoned) after readiness last evaluated it. Either way,
    // a higher-numbered pull request against the same base than the matched
    // candidate is necessarily a newer, later-created PR for this exact
    // branch/base combination — meaning the matched candidate cannot be the
    // approval this attempt is currently pursuing, and this shortcut must
    // defer to the live evaluate()-and-merge path below (which will itself
    // correctly reject, since evaluate() only ever considers open pull
    // requests) instead of recording the stale historical merge commit and
    // completing the task while the real approved change never lands.
    // (A pull request retargeted away from integrationTarget after
    // approval, rather than closed, is not distinguishable from an
    // unrelated PR that always targeted a different base by baseRef alone —
    // closing that narrower gap needs the approved PR's own identity
    // persisted at MERGE_READY time, which is out of scope for this
    // controller alone since three separate, already-shipped review
    // modules write that transition.)
    const supersededByNewerSameBasePr = matched !== null && candidates.some(
      (pr) => !pr.merged && pr.baseRef === integrationTarget && pr.number > matched.number,
    );
    const existing = matched !== null && !supersededByNewerSameBasePr ? matched : null;
    if (existing !== null && approvedRevision !== null) {
      // A prior attempt's merge provider call already succeeded (this exact
      // process crashed before recording evidence/transitioning, or the PR
      // was merged out of band); never call the merge endpoint again for a
      // revision this task's own MERGE_READY-for-revision approval covers.
      // (existing.merged and existing.headSha === approvedRevision are
      // already guaranteed by the find() predicate above.)
      if (existing.mergeCommitSha === null || existing.mergeCommitSha.length === 0) {
        throw new ControlledMergeError(
          "MERGE_NOT_CONFIRMED",
          `Task '${task.taskId}' pull request #${existing.number} reports merged=true with no usable merge commit SHA.`,
        );
      }
      assertHeld();
      return this.finalize(
        task,
        record,
        {
          revision: approvedRevision,
          pullRequestNumber: existing.number,
          mergeCommitSha: existing.mergeCommitSha,
          policyDecisionReference: `control-plane.merge-readiness:${task.taskId}@${approvedRevision}:previously-confirmed`,
          request,
          lockIdentityToRelease,
        },
        assertHeld,
      );
    }

    let readiness: EvaluateMergeReadinessResult;
    try {
      readiness = await this.dependencies.mergeReadiness.evaluate({ taskId: task.taskId });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ControlledMergeError("MERGE_PROVIDER_FAILED", `Task '${task.taskId}' merge-readiness evaluation failed: ${detail}`);
    }

    if (readiness.revision !== revision) {
      throw new ControlledMergeError(
        "HEAD_CHANGED",
        `Task '${task.taskId}' revision changed from '${revision}' to '${readiness.revision}' while merge readiness was being evaluated; retry once the branch is stable.`,
      );
    }

    if (!readiness.ready) {
      const reasons = readiness.reasons.map((reason) => reason.message).join("; ");
      throw new ControlledMergeError(
        "NOT_MERGE_READY",
        `Task '${task.taskId}' is not merge-ready for revision '${revision}': ${reasons}`,
      );
    }

    // ControlledMergeReadinessPort is a public port any caller may satisfy
    // with a different implementation, so a merely null-checked
    // pullRequestNumber is not enough: a non-positive or fractional value
    // (0, -5, 1.5) would still pass a null check, be fetched and merged
    // through the provider, and only be caught afterward when the merge
    // evidence schema rejects it as not a well-formed integer >= 1 —
    // stranding an already-irreversible provider merge in MERGE_READY.
    // Rejecting the same range here, before the PR recheck or merge call,
    // matches the boundary this controller already independently enforces
    // for an empty merge-commit SHA (never relying solely on a downstream
    // schema to catch what an upstream port could get wrong).
    if (
      readiness.pullRequestNumber === null ||
      !Number.isInteger(readiness.pullRequestNumber) ||
      readiness.pullRequestNumber < 1
    ) {
      throw new ControlledMergeError(
        "NOT_MERGE_READY",
        `Task '${task.taskId}' merge-readiness reported ready=true with an invalid pull request number '${String(readiness.pullRequestNumber)}'.`,
      );
    }

    // Re-read the exact pull request readiness selected, by number, one
    // more time immediately before invoking the merge provider: a push
    // landing in the gap between the readiness evaluation above and this
    // call must be detected locally even before the provider's own atomic
    // head check. Fetching by number (rather than re-running the
    // any-state/most-recent-by-head lookup findPullRequestsByHead uses) is
    // deliberate: a branch can legitimately have more than one pull request
    // across its history (for example a stray closed PR against a
    // different base, created more recently than the genuinely open,
    // approved one), and a most-recent-by-head lookup could return that
    // unrelated PR instead of the one readiness actually evaluated.
    let recheck: ControlledMergePullRequestRecord | null;
    try {
      recheck = await this.dependencies.pullRequests.getPullRequest(readiness.pullRequestNumber);
    } catch (error: unknown) {
      throw normalizeProviderError(task.taskId, error);
    }
    if (
      recheck === null ||
      recheck.merged ||
      recheck.state !== "open" ||
      recheck.headSha !== revision ||
      recheck.baseRef !== integrationTarget
    ) {
      throw new ControlledMergeError(
        "HEAD_CHANGED",
        `Task '${task.taskId}' pull request #${readiness.pullRequestNumber} changed between merge-readiness evaluation and merge; retry once the branch is stable.`,
      );
    }

    // Checked immediately before the one call in this module with an
    // irreversible external side effect: if this holder's heartbeat has
    // lapsed past the stale threshold and a concurrent caller has already
    // reclaimed the lock, aborting here — before ever invoking the merge
    // provider — is strictly better than aborting after, since it avoids a
    // wasted (and potentially confusing) duplicate merge attempt entirely.
    assertHeld();

    let mergeResult: ControlledMergeProviderResult;
    try {
      mergeResult = await this.dependencies.pullRequests.mergePullRequest({
        number: readiness.pullRequestNumber,
        expectedHeadSha: revision,
      });
    } catch (error: unknown) {
      throw normalizeProviderError(task.taskId, error);
    }

    if (!mergeResult.merged) {
      throw new ControlledMergeError(
        "MERGE_NOT_CONFIRMED",
        `Task '${task.taskId}' merge provider did not confirm pull request #${readiness.pullRequestNumber} was merged: ${mergeResult.message}`,
      );
    }
    // Enforced at this provider-neutral boundary, not only inside the
    // concrete GitHub adapter: a `ControlledMergePullRequestPort` is a
    // public port any caller may satisfy with their own implementation, and
    // this module's own confirmed-merge semantics (a real, usable commit
    // SHA) must hold regardless of which adapter is behind it, rather than
    // relying on every possible adapter to have independently reproduced
    // the GitHub adapter's own empty-sha rejection.
    if (mergeResult.sha.length === 0) {
      throw new ControlledMergeError(
        "MERGE_NOT_CONFIRMED",
        `Task '${task.taskId}' merge provider confirmed pull request #${readiness.pullRequestNumber} as merged but reported an empty merge commit SHA.`,
      );
    }

    // Re-checked here too: the merge provider call itself just spanned
    // another await boundary, during which this holder could have lost the
    // lock even if it still held it a moment ago at the check above.
    assertHeld();

    return this.finalize(
      task,
      record,
      {
        revision,
        pullRequestNumber: readiness.pullRequestNumber,
        mergeCommitSha: mergeResult.sha,
        policyDecisionReference: `control-plane.merge-readiness:${task.taskId}@${revision}:ready`,
        request,
        lockIdentityToRelease,
      },
      assertHeld,
    );
  }

  private async findPullRequests(taskId: string, head: string): Promise<readonly ControlledMergePullRequestRecord[]> {
    try {
      return await this.dependencies.pullRequests.findPullRequestsByHead(head);
    } catch (error: unknown) {
      throw normalizeProviderError(taskId, error);
    }
  }

  private finalize(
    task: RegisteredTask,
    record: LifecycleRecord,
    params: {
      readonly revision: string;
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly policyDecisionReference: string;
      readonly request: ControlledMergeRequest;
      readonly lockIdentityToRelease: LockIdentity | null;
    },
    assertHeld: () => void,
  ): ControlledMergeResult {
    const { revision, pullRequestNumber, mergeCommitSha, policyDecisionReference, request, lockIdentityToRelease } = params;

    // Every caller of finalize() already checked assertHeld() immediately
    // before calling it (right after the last await boundary on its own
    // path); this re-check costs nothing since nothing async happens
    // between that call and this one, and it means finalize() itself never
    // depends on every future call site remembering to fence first.
    assertHeld();

    // A prior attempt may have already recorded evidence for this exact
    // confirmed merge and then crashed before persisting the MERGE_READY ->
    // MERGED transition (lifecycle is still MERGE_READY, so this call
    // reaches finalize() again via the already-merged fast path). Reusing
    // that record — rather than appending a second, functionally duplicate
    // one — keeps the "exactly one ipt.merge-evidence record per confirmed
    // merge" invariant true even across that crash window.
    const lineageId = mergeEvidenceLineageId(task.taskId);
    const existingEvidence = this.getCurrentEvidence(task.taskId, lineageId);
    // isMergeEvidencePayloadFor performs the same full structural check
    // (schemaId, taskId, a well-formed pullRequestNumber/mergeCommitSha)
    // resolvePinnedEvidence already requires of a resumed record, closing
    // two gaps a bare three-field comparison left open: a null/non-object
    // payload (a hand-edited or corrupted evidence file) previously threw a
    // raw TypeError on every retry rather than being treated as simply not
    // reusable, and an object payload with the right three field values but
    // a wrong schemaId/taskId or missing other required fields would
    // otherwise still have been reused to persist MERGED/DONE. A record
    // that fails this check is never reused — finalize() falls through to
    // writing a fresh, valid record instead, self-healing past the
    // malformed one rather than trusting it or hard-failing on it.
    // isMergeEvidencePayloadFor only validates the *payload*; the record's
    // own wrapper fields (lineageId, sequence) are what evidenceRef below
    // is actually built from once reused, and are read directly off the
    // stored file's own JSON content without any cross-check against the
    // directory it was actually found in (see FileEvidenceStore.getHistory).
    // A corrupted wrapper — sequence rewritten to a number no file at this
    // lineage actually uses, or a lineageId that silently drifted from the
    // directory it lives in — would otherwise still be reused to build a
    // MERGED/DONE evidenceRef that resolvePinnedEvidence can never resolve
    // back on a later idempotent read, even though the payload itself was
    // perfectly valid.
    const wrapperIsTrustworthy =
      existingEvidence !== null &&
      existingEvidence.lineageId === lineageId &&
      Number.isInteger(existingEvidence.sequence) &&
      existingEvidence.sequence >= 1;
    const reusable =
      wrapperIsTrustworthy &&
      this.isMergeEvidencePayloadFor((existingEvidence as StoredEvidenceRecord).payload, task.taskId, revision) &&
      (existingEvidence as StoredEvidenceRecord).payload.pullRequestNumber === pullRequestNumber &&
      (existingEvidence as StoredEvidenceRecord).payload.mergeCommitSha === mergeCommitSha;

    // When reusing a record a prior, crashed attempt already wrote, the
    // lock identity to release is *that* record's own assignmentLockAtMerge
    // — never this retry's freshly captured lockIdentityToRelease. If the
    // original assignment was recovered and reassigned in the interim (the
    // exact reason this retry is even running with a different snapshot),
    // trusting the retry's own snapshot here would release the replacement
    // actor's active lock instead of correctly deferring to the identity
    // the original, now-reused evidence already pinned.
    let effectiveLockIdentityToRelease: LockIdentity | null;

    let evidenceLineageId: string;
    let evidenceSequence: number;
    if (reusable) {
      evidenceLineageId = (existingEvidence as StoredEvidenceRecord).lineageId;
      evidenceSequence = (existingEvidence as StoredEvidenceRecord).sequence;
      effectiveLockIdentityToRelease = parsePersistedLockIdentity(
        (existingEvidence as StoredEvidenceRecord).payload.assignmentLockAtMerge,
      );
    } else {
      // The assignment-lock identity active at this exact moment is
      // persisted alongside the evidence itself — not just held in this
      // call's own local variable — because a *later* resume (a different
      // merge() call, possibly in a different process, after this one
      // crashed before releasing the lock) must release only the identity
      // tied to *this* original attempt, never whatever lock happens to be
      // active when that later call runs. See resumeBookkeeping.
      const evidencePayload = {
        schemaId: "ipt.merge-evidence",
        schemaVersion: "1.0.0",
        evidenceId: `${task.taskId}:merge:${revision}:${request.occurredAt}`,
        taskId: task.taskId,
        revisionIdentity: revision,
        pullRequestNumber,
        mergeCommitSha,
        policyDecisionReference,
        recordedAt: request.occurredAt,
        assignmentLockAtMerge: lockIdentityToRelease,
      };
      // The provider has already, irreversibly, merged the pull request by
      // this point; a filesystem failure here (a full disk, an unwritable
      // evidence directory) must never propagate as a raw, uncaught
      // exception — it is normalized to EVIDENCE_REJECTED like every other
      // rejection this method can produce, and (unlike a genuine
      // schema-validation rejection) marked recoverable, since the
      // already-confirmed merge remains safely resumable once the
      // underlying I/O problem clears.
      //
      // Fenced immediately before this specific write: the top-of-method
      // check above only proves ownership at that instant, and the
      // getCurrentEvidence() read (and reusable computation) just before
      // this branch, though itself no slower than any other fs read, is
      // still enough real wall-clock time for a concurrent reclaim to land
      // in between — leaving this exact record() call as the next
      // unguarded write otherwise.
      assertHeld();
      let recorded: RecordResult;
      try {
        recorded = this.dependencies.evidenceStore.record(evidencePayload);
      } catch (error: unknown) {
        throw new ControlledMergeError(
          "EVIDENCE_REJECTED",
          `Task '${task.taskId}' merge evidence could not be persisted after a confirmed merge: ${detail(error)}`,
          true,
        );
      }
      if (!recorded.ok) {
        throw new ControlledMergeError(
          "EVIDENCE_REJECTED",
          `Task '${task.taskId}' merge evidence was rejected: ${recorded.rejection.code}: ${recorded.rejection.reasons.join("; ")}`,
          false,
        );
      }
      evidenceLineageId = recorded.record.lineageId;
      evidenceSequence = recorded.record.sequence;
      effectiveLockIdentityToRelease = lockIdentityToRelease;
    }

    // Re-checked immediately before this method's own next write: the
    // evidence write (or the reuse-check's read) just above has no async
    // gap of its own, but each fs operation still takes real wall-clock
    // time, during which a genuinely stale holder's lock can be reclaimed
    // by a concurrent process regardless of this process's own JS
    // scheduling — narrowing the fencing window to "between individual
    // writes," not just "once at the top of this whole call chain."
    assertHeld();

    const evidenceRef = `${evidenceLineageId}@${evidenceSequence}`;

    const mergedTransition = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: record.currentState,
      toState: "MERGED",
      eventId: `controlled-merge:${task.taskId}:${request.runId}:${record.currentState}->MERGED`,
      occurredAt: request.occurredAt,
      reason: `Controlled merge confirmed pull request #${pullRequestNumber} at merge commit '${mergeCommitSha}'.`,
      evidenceRef,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: ["MERGE_COMPLETED"],
      actorId: request.actorId,
      runId: request.runId,
      revisionIdentity: revision,
    });
    if (!mergedTransition.ok) {
      throw new ControlledMergeError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' ${record.currentState} -> MERGED: ${mergedTransition.rejection.code}: ${mergedTransition.rejection.reason}`,
      );
    }
    // Re-checked once more immediately before this write, for the same
    // reason as above.
    assertHeld();
    this.dependencies.stateStore.save(mergedTransition.record, record.currentState);

    return this.completeFromMerged(
      task,
      mergedTransition.record,
      request,
      {
        pullRequestNumber,
        mergeCommitSha,
        revision,
        evidenceLineageId,
        evidenceSequence,
        lockIdentityToRelease: effectiveLockIdentityToRelease,
      },
      assertHeld,
    );
  }

  private resumeBookkeeping(
    task: RegisteredTask,
    record: LifecycleRecord,
    request: ControlledMergeRequest,
    assertHeld: () => void,
  ): ControlledMergeResult {
    assertHeld();
    const evidence = this.resolvePinnedEvidence(task.taskId, record, "MERGED");
    const payload = evidence.payload as {
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly revisionIdentity: string;
      readonly assignmentLockAtMerge?: unknown;
    };
    // The lock identity to release is read from *this* evidence record —
    // the one this original, now-confirmed merge attempt itself persisted —
    // never re-snapshotted live from the lock store. A live snapshot here
    // would reflect whatever assignment happens to be active at the moment
    // of this (possibly much later, possibly different-process) resume
    // call, which could easily belong to a completely different, legitimate
    // later assignment of the same task.
    return this.completeFromMerged(
      task,
      record,
      request,
      {
        pullRequestNumber: payload.pullRequestNumber,
        mergeCommitSha: payload.mergeCommitSha,
        revision: payload.revisionIdentity,
        evidenceLineageId: evidence.lineageId,
        evidenceSequence: evidence.sequence,
        lockIdentityToRelease: parsePersistedLockIdentity(payload.assignmentLockAtMerge),
      },
      assertHeld,
    );
  }

  private completeFromMerged(
    task: RegisteredTask,
    record: LifecycleRecord,
    request: ControlledMergeRequest,
    details: {
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly revision: string;
      readonly evidenceLineageId: string;
      readonly evidenceSequence: number;
      readonly lockIdentityToRelease: LockIdentity | null;
    },
    assertHeld: () => void,
  ): ControlledMergeResult {
    // Fenced immediately before each of this method's two writes (the lock
    // release, then the DONE save), not only once by a caller further up
    // the chain — see finalize()'s own equivalent checks for why a single
    // check does not cover a chain of multiple, individually time-taking
    // fs operations.
    assertHeld();
    this.releaseLockIfPresent(task.taskId, request, details.lockIdentityToRelease);

    const doneTransition = transitionLifecycle(record, {
      taskId: task.taskId,
      expectedState: "MERGED",
      toState: "DONE",
      eventId: `controlled-merge:${task.taskId}:${request.runId}:MERGED->DONE`,
      occurredAt: request.occurredAt,
      reason: `Controlled merge completion recorded for pull request #${details.pullRequestNumber}.`,
      evidenceRef: `${details.evidenceLineageId}@${details.evidenceSequence}`,
      requiredReviewRoles: task.requiredReviewRoles as readonly ReviewRole[],
      satisfiedPrerequisites: ["COMPLETION_RECORDED"],
      actorId: request.actorId,
      runId: request.runId,
      revisionIdentity: details.revision,
    });
    if (!doneTransition.ok) {
      throw new ControlledMergeError(
        "LIFECYCLE_REJECTED",
        `Lifecycle rejected '${task.taskId}' MERGED -> DONE: ${doneTransition.rejection.code}: ${doneTransition.rejection.reason}`,
      );
    }
    assertHeld();
    this.dependencies.stateStore.save(doneTransition.record, "MERGED");

    return Object.freeze({
      taskId: task.taskId,
      lifecycleState: "DONE",
      pullRequestNumber: details.pullRequestNumber,
      sourceRevision: details.revision,
      mergeCommitSha: details.mergeCommitSha,
      evidenceLineageId: details.evidenceLineageId,
      evidenceSequence: details.evidenceSequence,
    });
  }

  private finishedResult(record: LifecycleRecord): ControlledMergeResult {
    const evidence = this.resolvePinnedEvidence(record.taskId, record, "DONE");
    const payload = evidence.payload as {
      readonly pullRequestNumber: number;
      readonly mergeCommitSha: string;
      readonly revisionIdentity: string;
    };
    return Object.freeze({
      taskId: record.taskId,
      lifecycleState: "DONE",
      pullRequestNumber: payload.pullRequestNumber,
      sourceRevision: payload.revisionIdentity,
      mergeCommitSha: payload.mergeCommitSha,
      evidenceLineageId: evidence.lineageId,
      evidenceSequence: evidence.sequence,
    });
  }

  // Reads the exact evidence record the task's own lifecycle history names
  // for the given transition (`${lineageId}@${sequence}` parsed from that
  // history event's evidenceRef) rather than whatever getCurrent() reports
  // as the lineage's current record right now — see parseEvidenceRef's doc
  // comment for why that distinction matters. Used to resume a MERGED task's
  // bookkeeping and to answer an already-DONE task's idempotent read.
  //
  // The lifecycle-history evidenceRef is treated as a claim, not a trusted
  // pointer: a corrupted or hand-edited lifecycle-state file could name a
  // syntactically valid lineage/sequence that belongs to a different task, a
  // different lineage kind entirely, or a revision other than the one this
  // exact transition recorded. Blindly trusting it would let the MERGED path
  // cast arbitrary payload fields and transition to DONE without genuine
  // task-specific merge evidence, or let the DONE path report another task's
  // result as this task's own. Every field the rest of this module reads off
  // the returned record (pullRequestNumber, mergeCommitSha, revisionIdentity)
  // is therefore verified against this task's own merge-evidence lineage and
  // the event's own revisionIdentity before it is returned.
  private resolvePinnedEvidence(taskId: string, record: LifecycleRecord, toState: "MERGED" | "DONE"): StoredEvidenceRecord {
    const event = latestHistoryEventToState(record, toState);
    if (event === null) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' is ${toState} but has no ${toState} lifecycle-history event to resolve evidence from.`,
        false,
      );
    }
    const parsed = parseEvidenceRef(event.evidenceRef);
    const expectedLineageId = mergeEvidenceLineageId(taskId);
    if (parsed === null || parsed.lineageId !== expectedLineageId) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' ${toState} lifecycle-history event has an evidenceRef '${event.evidenceRef}' that does not name this task's own merge-evidence lineage '${expectedLineageId}'.`,
        false,
      );
    }
    let history: readonly StoredEvidenceRecord[];
    try {
      history = this.dependencies.evidenceStore.getHistory(parsed.lineageId);
    } catch (error: unknown) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' merge evidence history could not be read: ${detail(error)}`,
        true,
      );
    }
    const exact = history.find((entry) => entry.sequence === parsed.sequence);
    if (exact === undefined) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' evidence record '${event.evidenceRef}' named by its ${toState} lifecycle-history event no longer exists.`,
        false,
      );
    }
    // getHistory(parsed.lineageId) already confirms this record was found in
    // the correct lineage *directory*, but the record's own `lineageId`
    // field is read directly off its stored file's JSON content, with no
    // cross-check against the directory it was actually found in (see
    // FileEvidenceStore.getHistory) — a corrupted wrapper (its content
    // hand-edited or partially written to name a different lineage) could
    // otherwise still be trusted here, and a later MERGED->DONE resume
    // would then build its own new evidenceRef from that wrong lineage,
    // leaving that next idempotent read unable to resolve its own evidence.
    if (exact.lineageId !== expectedLineageId) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' evidence record '${event.evidenceRef}' is stored with a corrupted wrapper lineageId '${exact.lineageId}' that does not match the expected lineage '${expectedLineageId}'.`,
        false,
      );
    }
    if (!this.isMergeEvidencePayloadFor(exact.payload, taskId, event.revisionIdentity)) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' evidence record '${event.evidenceRef}' named by its ${toState} lifecycle-history event is not valid merge evidence for this task's revision.`,
        false,
      );
    }
    return exact;
  }

  // Guards trust in a stored evidence payload wherever this controller is
  // about to treat one as describing this task's confirmed merge — both
  // resolvePinnedEvidence's resume/idempotent-read path and finalize()'s own
  // reuse check: it must actually be a *fully schema-valid* `ipt.merge-
  // evidence` record (via evidenceStore's own validate(), the exact check
  // record() itself would apply — not only a handful of loosely compared
  // field values, which a `schemaVersion` mismatch, a fractional
  // pullRequestNumber, or a missing evidenceId/policyDecisionReference/
  // recordedAt could otherwise slip past) for this exact task and the exact
  // revision the caller expects — anything else means the record, however
  // superficially plausible, does not describe this task's confirmed merge.
  private isMergeEvidencePayloadFor(payload: unknown, taskId: string, expectedRevision: string | undefined): boolean {
    if (typeof expectedRevision !== "string") return false;
    if (typeof payload !== "object" || payload === null) return false;
    // A throw from a provider-neutral validate() implementation (its schema
    // backend failing to read, for instance) is an infrastructure failure,
    // not a legitimate "this payload doesn't validate" determination — it
    // must be normalized into a recoverable ControlledMergeError the same
    // way every other evidence-store boundary call already is (see
    // getCurrentEvidence), not left to propagate raw or be silently treated
    // as "not reusable" (which would mask the failure by writing a fresh,
    // functionally duplicate evidence record instead of surfacing it).
    let validation: ValidateResult;
    try {
      validation = this.dependencies.evidenceStore.validate(payload);
    } catch (error: unknown) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' merge evidence could not be validated: ${detail(error)}`,
        true,
      );
    }
    if (!validation.ok) return false;
    const candidate = payload as Record<string, unknown>;
    return (
      candidate.schemaId === "ipt.merge-evidence" &&
      candidate.taskId === taskId &&
      candidate.revisionIdentity === expectedRevision &&
      typeof candidate.pullRequestNumber === "number" &&
      candidate.pullRequestNumber >= 1 &&
      typeof candidate.mergeCommitSha === "string" &&
      candidate.mergeCommitSha.length > 0
    );
  }

  // Normalizes a raw filesystem/I/O throw from the evidence store's
  // getCurrent() (used only by finalize()'s reuse check, which has no
  // lifecycle history to pin to yet) into a ControlledMergeError, matching
  // resolvePinnedEvidence's own normalization for the resume/idempotent
  // read paths.
  private getCurrentEvidence(taskId: string, lineageId: string): StoredEvidenceRecord | null {
    try {
      return this.dependencies.evidenceStore.getCurrent(lineageId);
    } catch (error: unknown) {
      throw new ControlledMergeError(
        "EVIDENCE_REJECTED",
        `Task '${taskId}' merge evidence could not be read: ${detail(error)}`,
        true,
      );
    }
  }

  // Lock release is best-effort and idempotent, but only ever touches the
  // exact assignment identity `lockIdentityToRelease` this call itself
  // captured at entry (before any provider call) — never whatever lock
  // happens to be active *now*. Comparing lockId alone would not be enough:
  // the assignment-lock contract does not guarantee a lockId is never reused
  // by a later acquisition once released, so the full identity (lockId,
  // ownerId, runId, canonicalBranch) must match before this call trusts that
  // the currently active lock is still the same one it observed. If that
  // lock is already gone, or a different — or merely differently-owned —
  // lock is now active (reassigned by an explicit stale-recovery operation,
  // or claimed by a fresh assignment, while this call was in flight), that
  // lock belongs to someone else's legitimate assignment and is left
  // untouched rather than released.
  private releaseLockIfPresent(taskId: string, request: ControlledMergeRequest, lockIdentityToRelease: LockIdentity | null): void {
    if (lockIdentityToRelease === null) {
      return;
    }
    // The merge and MERGED transition are already persisted by the time this
    // runs; an I/O failure reading the concrete lock store's own state (a
    // full disk, a malformed lock file) must never escape as a raw
    // exception — it is normalized to the same recoverable
    // LOCK_RELEASE_FAILED a rejected release already reports, so a caller
    // resuming this task's bookkeeping gets an actionable, typed error
    // rather than an opaque crash.
    let current: AssignmentLockRecord | null;
    try {
      current = this.dependencies.lockStore.get(taskId);
    } catch (error: unknown) {
      throw new ControlledMergeError(
        "LOCK_RELEASE_FAILED",
        `Task '${taskId}' assignment lock could not be read during completion: ${detail(error)}`,
        true,
      );
    }
    if (current === null) {
      // Fully gone (archived by a completed prior release, or never
      // existed) — nothing left to touch.
      return;
    }
    if (
      current.lockId !== lockIdentityToRelease.lockId ||
      current.ownerId !== lockIdentityToRelease.ownerId ||
      current.runId !== lockIdentityToRelease.runId ||
      current.canonicalBranch !== lockIdentityToRelease.canonicalBranch
    ) {
      // A different, legitimate assignment now holds this task's lock
      // (reassigned while this call, or an earlier crashed attempt, was in
      // flight) — left completely untouched regardless of its status.
      return;
    }
    // The identity still matches — call release() even if current.status is
    // already "RELEASED", rather than treating any non-ACTIVE status as
    // proof the release fully completed. The concrete store's own release()
    // writes the RELEASED status to the active record first, then appends
    // an audit event, then archives that record as three separate steps;
    // if either of the latter two throws, get() still observes status
    // RELEASED (the first write already landed) at a record that was never
    // actually archived and may have no audit entry. Treating that as
    // "already handled" would advance to DONE while silently abandoning
    // that unarchived record and its missing audit trail forever. Calling
    // release() again — safe because it only checks lockId ownership, not
    // status — either finishes that interrupted sequence (a harmless
    // duplicate RELEASED audit entry alongside a completed archive) or, if
    // the underlying failure persists, is caught below and normalized the
    // same way any other release failure is.
    // release() itself, not only get(), can throw on the concrete lock
    // store's own write path (its active-record write, audit append, or
    // archive rename) — the same normalization boundary applies here as to
    // the read above, rather than letting a filesystem failure escape as a
    // raw exception at this already-past-the-point-of-no-return moment.
    let result: LockResult;
    try {
      result = this.dependencies.lockStore.release({
        taskId,
        lockId: lockIdentityToRelease.lockId,
        actorId: request.actorId,
        runId: request.runId,
        occurredAt: request.occurredAt,
        reason: "Controlled merge completed; releasing assignment lock.",
        // Re-verified atomically, against the exact same read release()
        // itself performs, not only by the check above: the check above and
        // this call are two separate operations with a gap between them,
        // during which a stale-recovery replacing the assignment with a new
        // acquisition that happens to reuse this same lockId (a lockId reuse
        // the assignment-lock contract explicitly permits) would otherwise
        // still pass lockId-only matching inside release() and release that
        // new, differently-owned assignment.
        expectedOwnerId: lockIdentityToRelease.ownerId,
        expectedRunId: lockIdentityToRelease.runId,
        expectedCanonicalBranch: lockIdentityToRelease.canonicalBranch,
      });
    } catch (error: unknown) {
      throw new ControlledMergeError(
        "LOCK_RELEASE_FAILED",
        `Task '${taskId}' assignment lock release threw unexpectedly: ${detail(error)}`,
        true,
      );
    }
    if (!result.ok && result.rejection.code !== "LOCK_NOT_FOUND" && result.rejection.code !== "LOCK_ID_MISMATCH") {
      throw new ControlledMergeError(
        "LOCK_RELEASE_FAILED",
        `Task '${taskId}' assignment lock release was rejected: ${result.rejection.code}: ${result.rejection.reason}`,
      );
    }
  }
}

export type ControlledMergeErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND"
  | "TASK_STATE_NOT_MERGEABLE"
  | "BRANCH_REJECTED"
  | "NOT_MERGE_READY"
  | "HEAD_CHANGED"
  | "MERGE_PROVIDER_FAILED"
  | "MERGE_NOT_CONFIRMED"
  | "EVIDENCE_REJECTED"
  | "LIFECYCLE_REJECTED"
  | "LOCK_RELEASE_FAILED"
  | "STATE_CONFLICT"
  | "STATE_IO_FAILED";

export class ControlledMergeError extends Error {
  readonly code: ControlledMergeErrorCode;
  readonly recoverable: boolean;

  constructor(code: ControlledMergeErrorCode, message: string, recoverable = true) {
    super(message);
    this.name = "ControlledMergeError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export interface ControlledMergeRequest {
  readonly taskId: string;
  readonly actorId: string;
  readonly runId: string;
  readonly occurredAt: string;
}

export interface ControlledMergeResult {
  readonly taskId: string;
  readonly lifecycleState: "DONE";
  readonly pullRequestNumber: number;
  readonly sourceRevision: string;
  readonly mergeCommitSha: string;
  readonly evidenceLineageId: string;
  readonly evidenceSequence: number;
}

export interface ControlledMergeStateStore {
  get(taskId: string): LifecycleRecord | null;
  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void;
}

export interface ControlledMergeBranchAdapter {
  canonicalBranch(task: TaskBranchMetadata): string;
  assertCurrentTaskBranch(task: TaskBranchMetadata): void;
  currentRevision(): string;
}

export interface ControlledMergeReadinessPort {
  evaluate(request: { readonly taskId: string }): Promise<EvaluateMergeReadinessResult>;
}

export interface ControlledMergeEvidenceStore {
  record(payload: unknown): RecordResult;
  // A pure, read-only check applying the exact same schema validation
  // record() itself would — used to revalidate a *stored* candidate record
  // before ever trusting it as reusable (see finalize()'s reuse check),
  // rather than trusting a bare comparison of a few field values.
  validate(payload: unknown): ValidateResult;
  getCurrent(lineageId: string): StoredEvidenceRecord | null;
  getHistory(lineageId: string): readonly StoredEvidenceRecord[];
}

// Captured once at merge() entry and compared in full (never lockId alone)
// before completion releases an assignment lock — see releaseLockIfPresent's
// doc comment for why lockId alone is not a safe-enough identity check.
export interface LockIdentity {
  readonly lockId: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly canonicalBranch: string;
}

export interface ControlledMergeLockStore {
  get(taskId: string): AssignmentLockRecord | null;
  release(request: {
    readonly taskId: string;
    readonly lockId: string;
    readonly actorId: string;
    readonly runId: string;
    readonly occurredAt: string;
    readonly reason: string;
    // Optional compare-and-swap guard: when provided, an implementation
    // rejects the release (LOCK_ID_MISMATCH) unless the currently active
    // record's ownerId/runId/canonicalBranch also match, atomically against
    // the same read it uses to decide whether to mutate anything —
    // narrowing the gap between this controller's own full-identity check
    // and the actual release call, during which a stale-recovery reusing
    // this exact lockId (permitted by the assignment-lock contract) could
    // otherwise still pass a lockId-only match.
    readonly expectedOwnerId?: string;
    readonly expectedRunId?: string;
    readonly expectedCanonicalBranch?: string;
  }): LockResult;
}

export interface ControlledMergePullRequestRecord {
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

export interface MergePullRequestParams {
  readonly number: number;
  readonly expectedHeadSha: string;
}

export interface ControlledMergeProviderResult {
  readonly merged: boolean;
  readonly sha: string;
  readonly message: string;
}

export interface ControlledMergePullRequestPort {
  findPullRequestsByHead(head: string): Promise<readonly ControlledMergePullRequestRecord[]>;
  getPullRequest(number: number): Promise<ControlledMergePullRequestRecord | null>;
  mergePullRequest(params: MergePullRequestParams): Promise<ControlledMergeProviderResult>;
}

/**
 * Mutual exclusion for the entire read-decide-write critical section of one
 * task's controlled merge (existing-merge check, readiness re-evaluation,
 * pre-merge re-check, merge provider call, evidence write, and lifecycle
 * writes together), extended to an async `fn` since this module's critical
 * section spans awaited provider calls — mirrors BOOT-018's/BOOT-019's/
 * BOOT-020's/BOOT-021's own synchronous task locks, whose critical sections
 * never needed to span an async boundary.
 *
 * `fn` receives an `assertHeld` fencing callback: a synchronous check,
 * cheap enough to call before every side-effecting operation, that throws
 * if this holder's lock has since been lost to a concurrent reclaim (its
 * own heartbeat having lapsed past the stale threshold — a slow process
 * pause, an interval that failed to fire). A periodic heartbeat alone
 * narrows how often that can happen but cannot, on a plain file lock,
 * guarantee it never does; `assertHeld` is the caller's own last line of
 * defense, letting it abort before a provider call or a write rather than
 * silently completing one alongside a second, legitimate holder.
 */
export interface ControlledMergeTaskLock {
  withLock<T>(taskId: string, fn: (assertHeld: () => void) => Promise<T>): Promise<T>;
}

export interface ControlledMergeDependencies {
  readonly registry: TaskRegistry;
  readonly stateStore: ControlledMergeStateStore;
  readonly taskLock: ControlledMergeTaskLock;
  readonly branchLifecycle: ControlledMergeBranchAdapter;
  readonly mergeReadiness: ControlledMergeReadinessPort;
  readonly evidenceStore: ControlledMergeEvidenceStore;
  readonly lockStore: ControlledMergeLockStore;
  readonly pullRequests: ControlledMergePullRequestPort;
  readonly integrationTarget?: string;
}

export class FileControlledMergeStateStore implements ControlledMergeStateStore {
  constructor(private readonly root: string) {
    if (root.trim().length === 0) throw new RangeError("Lifecycle state root must be non-empty.");
    mkdirSync(root, { recursive: true });
  }

  get(taskId: string): LifecycleRecord | null {
    const path = this.pathFor(taskId);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as LifecycleRecord;
      if (value.taskId !== taskId || !isLifecycleState(value.currentState) || !Array.isArray(value.history)) {
        throw new Error("record identity/state/history is invalid");
      }
      return value;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ControlledMergeError("STATE_IO_FAILED", `Cannot read lifecycle state for '${taskId}': ${detail}`, false);
    }
  }

  save(record: LifecycleRecord, expectedCurrentState: TaskLifecycleState): void {
    const current = this.get(record.taskId);
    const actualState = current?.currentState ?? "PLANNED";
    if (actualState !== expectedCurrentState) {
      throw new ControlledMergeError(
        "STATE_CONFLICT",
        `Lifecycle state for '${record.taskId}' changed from expected '${expectedCurrentState}' to '${actualState}' before merge commit.`,
      );
    }

    const path = this.pathFor(record.taskId);
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
      renameSync(temporary, path);
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      const detail = error instanceof Error ? error.message : String(error);
      throw new ControlledMergeError("STATE_IO_FAILED", `Cannot persist lifecycle state for '${record.taskId}': ${detail}`);
    }
  }

  private pathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.json`);
  }
}

export interface FileControlledMergeTaskLockOptions {
  // Overridable only for tests; production callers rely on the defaults
  // (STALE_LOCK_MS, DEFAULT_HEARTBEAT_INTERVAL_MS) matching the other task
  // locks' own threshold.
  readonly staleLockMs?: number;
  readonly heartbeatIntervalMs?: number;
}

/**
 * Exclusive per-task mutual exclusion via an exclusive-create lock file,
 * shared across OS processes, mirroring BOOT-021's own `FileReviewReworkTaskLock`
 * exactly (per-acquisition token, atomic-rename stale reclaim that
 * re-verifies it captured the stale instance rather than a fresh lock,
 * ownership-safe release) but with an async `withLock` so the held lock
 * spans this module's awaited provider calls rather than only synchronous
 * file I/O — and, because those awaited calls can legitimately run long,
 * with a periodic heartbeat that refreshes the lock file's timestamp while
 * `fn` is active. Without the heartbeat, a `merge()` call whose readiness
 * evaluation or GitHub provider calls took longer than the stale threshold
 * would look identical to an abandoned lock, and a concurrent caller would
 * reclaim it and enter the same "exclusive" section.
 */
export class FileControlledMergeTaskLock implements ControlledMergeTaskLock {
  private readonly staleLockMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly root: string, options: FileControlledMergeTaskLockOptions = {}) {
    if (root.trim().length === 0) throw new RangeError("Task lock root must be non-empty.");
    mkdirSync(root, { recursive: true });
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  async withLock<T>(taskId: string, fn: (assertHeld: () => void) => Promise<T>): Promise<T> {
    const lockPath = this.lockPathFor(taskId);
    let token = this.acquire(lockPath, taskId);
    const heartbeat = setInterval(() => {
      token = this.refresh(lockPath, token);
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();
    const assertHeld = (): void => {
      if (!this.isHeldBy(lockPath, token)) {
        throw new ControlledMergeError(
          "STATE_CONFLICT",
          `Task '${taskId}' controlled-merge lock was lost to a concurrent reclaim; aborting before any further write.`,
          true,
        );
      }
    };
    try {
      return await fn(assertHeld);
    } finally {
      clearInterval(heartbeat);
      this.release(lockPath, token);
    }
  }

  private acquire(lockPath: string, taskId: string): string {
    const created = this.tryCreate(lockPath);
    if (created !== null) return created;
    if (this.reclaimIfStale(lockPath)) {
      const retried = this.tryCreate(lockPath);
      if (retried !== null) return retried;
    }
    throw new ControlledMergeError(
      "STATE_CONFLICT",
      `Task '${taskId}' controlled merge is already in progress by a concurrent caller; retry once it finishes.`,
    );
  }

  // Extends the lock file's modification time — never its content, and
  // never by removing it — only while this holder still actually owns the
  // file. An earlier version of this method renamed the lock path away to
  // perform the ownership check atomically, then wrote a fresh file back;
  // that left a real (if brief) window, once per heartbeat interval, where
  // the lock path did not exist at all. Any concurrent, ordinary acquire()
  // for the same task — not merely a stale-reclaim contender — could then
  // succeed inside that window via its own exclusive-create tryCreate(),
  // producing two callbacks running inside the supposedly exclusive section
  // at once. Touching only mtime, via a metadata-only utimesSync call,
  // never deletes or truncates the file: the lock path remains continuously
  // present and continuously EEXIST to any concurrent tryCreate() for the
  // entire time this holder legitimately owns it, so that race cannot
  // occur. Staleness detection (reclaimIfStale) reads this mtime rather
  // than a timestamp embedded in the file's content, so this refresh is
  // exactly the same signal reclaimIfStale checks. The read-then-touch pair
  // below is not perfectly atomic — a concurrent stale-reclaim could still
  // land in the narrow gap between them — but the worst case is merely
  // nudging a just-reclaimed lock's mtime forward slightly (never
  // resurrecting removed content, never faking exclusive ownership away
  // from a fresh holder), the same order of residual risk already accepted
  // for a heartbeat interval that itself runs longer than staleLockMs.
  private refresh(lockPath: string, token: string): string {
    let observed: string | null;
    try {
      observed = readFileSync(lockPath, "utf8");
    } catch {
      return token;
    }
    if (observed !== token) {
      // Reclaimed by another process as stale; nothing left for this
      // (former) holder to refresh.
      return token;
    }
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // Lost ownership in the gap between the read above and this call;
      // nothing further to do.
    }
    return token;
  }

  // Backs the assertHeld fencing callback withLock hands to fn(): true only
  // while the lock file's content still matches this holder's own token.
  // This does not, on its own, make a check-then-write sequence perfectly
  // atomic (another process could still reclaim in the gap between this
  // read and whatever write assertHeld guards) — but calling it immediately
  // before every side-effecting operation narrows that gap to one
  // synchronous file read, the same order of residual risk already accepted
  // for the heartbeat's own read-then-touch pair in refresh().
  private isHeldBy(lockPath: string, token: string): boolean {
    try {
      return readFileSync(lockPath, "utf8") === token;
    } catch {
      return false;
    }
  }

  // A plain read-then-unlink (the original implementation) is not actually
  // atomic: if a stale reclaimer's own claim (reclaimIfStale) renames the
  // old lock away, verifies it, and writes its own fresh replacement back
  // to lockPath in the gap between this call's read and its unlinkSync,
  // that unlinkSync would delete the *replacement's* lock file — not this
  // (already-gone) holder's own — letting a third caller's tryCreate()
  // succeed as if the task were unlocked, while the replacement's own
  // callback is still actively running unaware it lost its lock. Claiming
  // the path via an atomic rename first, then verifying the captured
  // content is genuinely this holder's own token before discarding it (or
  // restoring it untouched otherwise), closes that gap the same way
  // reclaimIfStale's own claim already does.
  //
  // That claiming rename still leaves lockPath briefly absent while this
  // call decides what to do with what it captured — and, on its own, a
  // concurrent ordinary tryCreate() (used both by fresh acquisition and by
  // a stale reclaimer's own replacement write) could succeed inside that
  // window, making a still-live replacement lock appear unlocked and let a
  // third caller start running its callback alongside it. A reservation
  // file, checked by tryCreate() both before and after its own write (see
  // there), keeps ordinary lock creation blocked for this call's full
  // duration, so that window can no longer be exploited.
  private release(lockPath: string, token: string): void {
    this.reclaimAbandonedReservation(lockPath);

    const reservationPath = this.releaseReservationPath(lockPath);
    try {
      writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
    } catch {
      // Another release() for this exact lock path is already in flight;
      // back off rather than risk two release() calls racing each other.
      return;
    }
    try {
      this.releaseClaimed(lockPath, token);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private releaseClaimed(lockPath: string, token: string): void {
    // Fixed, not randomized: the reservation marker above already
    // guarantees only one release() or reclaimIfStale() attempt is ever in
    // flight for this exact lock path at a time, so a fixed path cannot
    // collide, and a fixed, well-known name is what makes an orphaned claim
    // (left by a process that crashed mid-release) recoverable by
    // reclaimAbandonedReservation later.
    const claimPath = this.releaseClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return; // Already gone; nothing left to release.
    }

    let observed: string | null;
    try {
      observed = readFileSync(claimPath, "utf8");
    } catch {
      observed = null;
    }
    if (observed !== token) {
      // Not this holder's own lock (a reclaimer's fresh replacement, most
      // likely) — restore it untouched rather than discarding it.
      if (observed !== null) {
        try {
          writeFileSync(lockPath, observed, { encoding: "utf8", flag: "wx" });
        } catch {
          // A fresh lock now exists at lockPath; nothing to restore onto.
        }
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return;
    }
    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
  }

  private releaseReservationPath(lockPath: string): string {
    return `${lockPath}.release-reservation`;
  }

  private releaseClaimedPath(lockPath: string): string {
    return `${lockPath}.release-claim`;
  }

  private reclaimClaimedPath(lockPath: string): string {
    return `${lockPath}.reclaim-claim`;
  }

  private tryCreateRollbackClaimPath(lockPath: string): string {
    return `${lockPath}.try-create-rollback-claim`;
  }

  // The reservation marker above (and whichever claimed-content file it was
  // guarding — release()'s own, or reclaimIfStale()'s) is normally cleaned
  // up in that call's own `finally` within microseconds. If the process
  // holding it is instead killed or crashes mid-operation, nothing else
  // ever cleans either up: the marker would otherwise block every future
  // tryCreate() forever (this.staleLockMs never revisited, since tryCreate
  // only ever checked existence), permanently wedging controlled merge for
  // the task, and — if the crash happened after the lock path was already
  // renamed away but before it was restored or replaced — that content
  // would sit orphaned at a fixed path no other code path ever revisits.
  // Once the marker is older than staleLockMs (the same abandoned-holder
  // threshold already governing the lock file itself), this restores
  // whichever fixed claim path actually holds orphaned content back to
  // lockPath — so it re-enters the normal held/stale lifecycle rather than
  // vanishing or leaving the task appearing falsely unlocked — before
  // dropping the stale marker itself.
  private reclaimAbandonedReservation(lockPath: string): void {
    const reservationPath = this.releaseReservationPath(lockPath);
    const reclaimMarkerPath = `${reservationPath}.reclaim`;

    // A plain stat-then-unlink (the original implementation) is not
    // actually atomic: another caller could, in the gap between the
    // staleness check below and the removal further down, *itself* finish
    // reclaiming this exact stale marker and start its own fresh, live
    // release()/reclaimIfStale() call (writing a brand-new marker at this
    // same path). Blindly unlinking at that point would strip that fresh,
    // in-flight call of its own protection mid-flight — the same class of
    // bug this whole reservation mechanism exists to prevent. Claiming the
    // marker via an atomic rename first, then re-checking the *captured*
    // file's own age (rename preserves mtime), tells the two cases apart:
    // whichever caller's rename lands first captures whatever is genuinely
    // at this path at that instant, and only a capture that is still old
    // enough is ever treated as abandoned.
    let stats: { readonly mtimeMs: number } | null;
    try {
      stats = statSync(reservationPath);
    } catch {
      stats = null;
    }

    if (stats !== null) {
      if (Date.now() - stats.mtimeMs <= this.staleLockMs) return;
      try {
        renameSync(reservationPath, reclaimMarkerPath);
      } catch {
        // Already gone; fall through to check reclaimMarkerPath directly —
        // another caller may have already claimed it in this exact gap.
      }
    } else if (!existsSync(reclaimMarkerPath)) {
      // No reservation, and no orphaned claim left behind by a process
      // that crashed mid-reclaim either: nothing to do.
      return;
    }
    // reclaimMarkerPath may now exist either because this call just claimed
    // it above, or because it was already sitting there — which can only
    // mean a *previous* call crashed between renaming the original
    // reservation away and finishing this same recovery (a rename is never
    // observed half-done), or that a concurrent caller reached this exact
    // point moments earlier.
    let claimedStats: { readonly mtimeMs: number } | null;
    try {
      claimedStats = statSync(reclaimMarkerPath);
    } catch {
      claimedStats = null;
    }
    if (claimedStats === null) return;
    if (Date.now() - claimedStats.mtimeMs <= this.staleLockMs) {
      // Not actually stale: reclaimMarkerPath's mtime can only ever be this
      // recent if a legitimate, brand-new reservation was swept into this
      // call's own renameSync(reservationPath, reclaimMarkerPath) above (a
      // prior holder's release()/reclaimIfStale() call finished and
      // unlinked the genuinely-stale reservation in the exact gap between
      // this call's staleness read and its rename, and a fresh one was
      // created before that rename landed — the rename then captured the
      // new one, mtime and all). Restore it untouched rather than
      // discarding a live reservation.
      try {
        renameSync(reclaimMarkerPath, reservationPath);
      } catch {
        // A third operation has since created its own fresh marker at
        // reservationPath; there is nothing further to restore onto.
      }
      return;
    }

    // Nothing so far has actually *claimed* sole ownership of the
    // now-confirmed-stale reclaimMarkerPath — only observed and re-verified
    // that it exists and is old. Left at a bare observation, every
    // concurrent caller reaching here would race each other through the
    // restore logic below on the very same fixed claim paths. Claim
    // exclusive ownership of *this* recovery attempt first: capture the
    // marker's content and mtime, then re-establish both at a dedicated,
    // private claim path via an exclusive-create write. This path is
    // deliberately distinct from reservationPath itself — reusing
    // reservationPath here (an earlier version of this fix did) would let
    // a completely unrelated, brand-new release()/reclaimIfStale() call
    // mistake this call's own in-progress claim for a stale *public*
    // reservation of its own and race it via the exact same
    // renameSync(reservationPath, reclaimMarkerPath) above, since neither
    // release() nor reclaimIfStale() checks reclaimMarkerPath before
    // creating a fresh reservationPath. A private, fixed name that no
    // other code path ever inspects cannot be confused with anything else;
    // reclaimMarkerPath itself is left completely untouched until this
    // claim fully lands, so it keeps blocking tryCreate() and this
    // function's own primary branch for the entire recovery, exactly as it
    // already did before this claim began. Exactly one concurrent caller
    // can win the exclusive create; every other caller's own attempt fails
    // and it backs off untouched, the same way tryCreate()'s own EEXIST
    // handling already protects the lock file itself.
    const recoveryClaimPath = `${reclaimMarkerPath}.recovery-claim`;
    let markerContent: string;
    let markerMtime: Date;
    try {
      markerContent = readFileSync(reclaimMarkerPath, "utf8");
      markerMtime = new Date(statSync(reclaimMarkerPath).mtimeMs);
    } catch {
      return; // Already gone; another caller already claimed or finished it.
    }
    try {
      writeFileSync(recoveryClaimPath, markerContent, { encoding: "utf8", flag: "wx" });
      try {
        utimesSync(recoveryClaimPath, markerMtime, markerMtime);
      } catch {
        // Lost ownership of the just-written file in an extremely narrow
        // window; harmless — nothing downstream depends on this copy's own
        // mtime once ownership is established.
      }
    } catch (error: unknown) {
      // EEXIST can mean two different things: a genuinely concurrent
      // caller currently racing this exact claim right now (a live claim,
      // back off and let it finish), or an earlier caller's own claim that
      // itself crashed before finishing — recoveryClaimPath is private and
      // the only code that ever writes to it is this exact block, so if
      // one is already sitting there and old enough to be considered
      // abandoned by the same staleLockMs threshold as everything else in
      // this method, this generation never completed and would otherwise
      // wedge reclaimMarkerPath (still present, per the read above) as a
      // permanent block on tryCreate() forever, with nothing left to ever
      // revisit it — the exact same recursive-crash gap already closed for
      // reclaimMarkerPath itself, one level deeper. There is nothing left
      // to *claim* in that case: this caller simply resumes the very same
      // recovery using the orphaned copy already there (its content is
      // necessarily identical to what was just read from reclaimMarkerPath
      // above, since nothing ever mutates either file's content after
      // creation — only this claim step writes recoveryClaimPath, and
      // reclaimMarkerPath's own content never changes until it is finally
      // unlinked).
      if (errorCode(error) !== "EEXIST") return;
      let existingClaimStats: { readonly mtimeMs: number } | null;
      try {
        existingClaimStats = statSync(recoveryClaimPath);
      } catch {
        existingClaimStats = null;
      }
      if (existingClaimStats === null || Date.now() - existingClaimStats.mtimeMs <= this.staleLockMs) {
        // Either it just vanished (another caller already finished this
        // exact recovery — nothing left to do), or it is still genuinely
        // fresh (a live, concurrent claim in flight right now) — back off
        // either way rather than race it.
        return;
      }
    }

    // Restoring via a plain renameSync onto lockPath would not be safe
    // here: POSIX rename() silently *replaces* an existing destination
    // file rather than failing, unlike release()'s/reclaimIfStale()'s own
    // claim-verify steps (which all use an exclusive-create writeFileSync
    // for exactly this reason). Reading the orphaned content and writing it
    // back with flag:"wx" instead means a concurrent, legitimate tryCreate()
    // that already created a fresh lock at lockPath — possible during the
    // narrow window between claiming this stale reservation above and this
    // restore, since tryCreate() also recognizes the ".reclaim" marker
    // below precisely to keep that window as narrow as an ordinary
    // tryCreate()'s own single ownership check — is never silently
    // clobbered.
    for (const claimPath of [this.releaseClaimedPath(lockPath), this.reclaimClaimedPath(lockPath)]) {
      let orphaned: string;
      let orphanedMtime: Date;
      try {
        orphaned = readFileSync(claimPath, "utf8");
        orphanedMtime = new Date(statSync(claimPath).mtimeMs);
      } catch {
        continue; // Not present at this candidate location; try the other one.
      }
      try {
        writeFileSync(lockPath, orphaned, { encoding: "utf8", flag: "wx" });
        // writeFileSync stamps a brand-new mtime (now), which would make
        // this restored, genuinely abandoned lock read as freshly held —
        // wedging it behind a full extra staleLockMs wait before
        // reclaimIfStale() would consider it stale again. Restoring the
        // orphan's own original mtime keeps its staleness signal intact,
        // so it re-enters the normal stale-lock lifecycle immediately
        // rather than needing to age out a second time.
        try {
          utimesSync(lockPath, orphanedMtime, orphanedMtime);
        } catch {
          // Lost ownership of the just-written file in an extremely
          // narrow window; the lock will simply need to age out again.
        }
      } catch {
        // lockPath already holds a fresh record — a concurrent, legitimate
        // tryCreate() won the race; leave it untouched.
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      break;
    }
    try {
      unlinkSync(reclaimMarkerPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    try {
      unlinkSync(recoveryClaimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
  }

  private tryCreate(lockPath: string): string | null {
    // A release() or reclaimIfStale() call in flight for this exact lock
    // path has claimed it away for inspection (see their own comments):
    // ordinary creation must stay blocked for that entire window, not just
    // observe the path as transiently vacant, or a still-live replacement
    // lock could appear unlocked to a concurrent caller. Reclaiming first
    // means an abandoned (crashed) reservation never wedges this check
    // forever.
    this.reclaimAbandonedReservation(lockPath);
    const reservationPath = this.releaseReservationPath(lockPath);
    // Also recognizes reclaimAbandonedReservation's own temporary claim on
    // the reservation marker (".reclaim"): that claim briefly removes the
    // marker from its normal path while deciding whether it is genuinely
    // stale, and ordinary creation must stay blocked for that entire window
    // too, not just observe the marker as momentarily absent — otherwise a
    // fresh tryCreate() could win a race the restore step then has to defer
    // to anyway, needlessly losing the orphaned lock it was trying to
    // recover instead of simply waiting the reclaim out.
    const reclaimMarkerPath = `${reservationPath}.reclaim`;
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) return null;
    // The token is just a random identity, not a timestamp: staleness is
    // now determined from the lock file's own filesystem mtime (see
    // reclaimIfStale/refresh), not from anything embedded in its content.
    const token = randomLockToken();
    try {
      writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ControlledMergeError("STATE_IO_FAILED", `Cannot create controlled-merge task lock at '${lockPath}': ${detail}`);
    }
    if (existsSync(reservationPath) || existsSync(reclaimMarkerPath)) {
      // A release()/reclaimIfStale() call reserved this exact lock path in
      // the narrow gap between this call's own pre-write check and its
      // write landing; back off rather than let this freshly created lock
      // stand in for real ownership while that call is still deciding what
      // to do with the content it claimed. An unconditional unlink here is
      // not safe, though: by the time it runs, a reclaimer could already
      // have renamed this exact token away, found it did not match what it
      // expected (the reclaimer's own stale-content check), and restored
      // it — and, separately, a fresh tryCreate() elsewhere could since
      // have exclusively created a brand-new token of its own at this same
      // path once that reclaimer's reservation was cleaned up. Blindly
      // unlinking at that point would delete that later, unrelated
      // holder's lock instead of this attempt's own, leaving lockPath
      // vacant while that holder's callback is still actively running and
      // free for yet another caller to also win. Claim whatever currently
      // sits at lockPath via the same atomic-rename-then-verify pattern
      // used everywhere else in this class, and only ever discard it if it
      // is still genuinely this attempt's own token.
      const rollbackClaimPath = this.tryCreateRollbackClaimPath(lockPath);
      let claimed: string | null;
      try {
        renameSync(lockPath, rollbackClaimPath);
      } catch {
        // Already gone — reclaimed, or rolled back by this same logic on a
        // concurrent call; nothing left to roll back.
        return null;
      }
      try {
        claimed = readFileSync(rollbackClaimPath, "utf8");
      } catch {
        claimed = null;
      }
      if (claimed !== token && claimed !== null) {
        // Not this attempt's own token — a reclaimer's legitimate
        // replacement landed here first. Restore it untouched rather than
        // discarding someone else's live lock; a plain rename is not safe
        // here either, since a third, independent tryCreate() could have
        // exclusively created yet another fresh token at lockPath in this
        // same gap.
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // lockPath already holds a fresher record of its own; nothing to
          // restore onto.
        }
      }
      try {
        unlinkSync(rollbackClaimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return null;
    }
    return token;
  }

  // See BOOT-020's `FileUatReviewTaskLock.reclaimIfStale` for the full
  // rationale (unchanged here): a bare rename cannot distinguish "I captured
  // the stale lock" from "I captured a fresh lock a different caller created
  // after the original stale holder legitimately released it," so the
  // content the rename actually captured is re-read and compared against
  // what was observed as stale before it is discarded.
  //
  // Staleness itself is judged from the lock file's own filesystem mtime
  // (bumped by a live holder's heartbeat via refresh()'s utimesSync call)
  // rather than a timestamp parsed out of its content: this is the same
  // signal a legitimate holder's heartbeat actually updates, so a holder
  // that is still refreshing on schedule is never mistaken for abandoned.
  private reclaimIfStale(lockPath: string): boolean {
    this.reclaimAbandonedReservation(lockPath);

    let stats: { readonly mtimeMs: number };
    try {
      stats = statSync(lockPath);
    } catch {
      return false;
    }
    if (Date.now() - stats.mtimeMs <= this.staleLockMs) return false;

    // Captured in the same breath as the staleness check above, not by a
    // fresh read later inside reclaimClaimed(): if a legitimate holder
    // releases this exact stale lock and a fresh holder B acquires it in
    // the gap between this staleness check and the reservation being taken
    // below, a later read at that point would just be B's own live content
    // — comparing it against itself inside reclaimClaimed() would then
    // trivially "match" (nothing else touched it in between), discarding
    // B's live lock without ever actually having observed it to be stale.
    // Pinning the comparison baseline to the exact content read at
    // staleness-check time closes that gap: a legitimate replacement's
    // different token/content is then correctly seen as a mismatch.
    let observedAtStaleCheck: string;
    try {
      observedAtStaleCheck = readFileSync(lockPath, "utf8");
    } catch {
      return false;
    }

    // Claiming the path away below leaves it briefly absent while this call
    // decides whether the captured content is genuinely still the stale
    // lock it observed — the same window release() closes with the
    // identical reservation, applied here for the identical reason: without
    // it, a concurrent tryCreate() (fresh acquisition, or a live holder B
    // that already legitimately replaced this stale lock before this
    // rename landed) could succeed inside that window and start running
    // its callback alongside whatever this reclaim ultimately decides,
    // breaking exclusivity around the controlled-merge critical section.
    const reservationPath = this.releaseReservationPath(lockPath);
    try {
      writeFileSync(reservationPath, "", { encoding: "utf8", flag: "wx" });
    } catch {
      // A release() or another reclaimIfStale() attempt is already in
      // flight for this exact lock path; back off rather than race it.
      return false;
    }
    try {
      return this.reclaimClaimed(lockPath, observedAtStaleCheck);
    } finally {
      try {
        unlinkSync(reservationPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
    }
  }

  private reclaimClaimed(lockPath: string, observed: string): boolean {
    // Fixed, not randomized: see releaseClaimed's own comment — the
    // reservation held above guarantees exclusivity, and a fixed, well-known
    // name is what makes an orphaned claim recoverable after a crash.
    const claimPath = this.reclaimClaimedPath(lockPath);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return false;
    }

    // A rename preserves mtime, so this reflects whatever mtime the file
    // genuinely had at the instant it was just claimed — not the earlier
    // statSync reclaimIfStale used to decide staleness before this call
    // even began. refresh() bumps a live holder's mtime via a metadata-
    // only utimesSync without ever touching content, so a holder that
    // refreshed its heartbeat in the gap between that earlier check and
    // this claim would read back identical content below even though it
    // is, right now, demonstrably not stale — content identity alone is
    // not sufficient proof of abandonment when the thing that actually
    // changed is the mtime, not the bytes.
    let claimedStats: { readonly mtimeMs: number } | null;
    try {
      claimedStats = statSync(claimPath);
    } catch {
      claimedStats = null;
    }
    const stillStale = claimedStats !== null && Date.now() - claimedStats.mtimeMs > this.staleLockMs;

    let claimed: string | null;
    try {
      claimed = readFileSync(claimPath, "utf8");
    } catch {
      claimed = null;
    }
    if (claimed !== observed || !stillStale) {
      if (claimed !== null) {
        try {
          writeFileSync(lockPath, claimed, { encoding: "utf8", flag: "wx" });
        } catch {
          // A third caller has since created its own fresh lock at
          // lockPath; there is nothing to restore onto.
        }
      }
      try {
        unlinkSync(claimPath);
      } catch {
        // Already gone; nothing left to clean up.
      }
      return false;
    }

    try {
      unlinkSync(claimPath);
    } catch {
      // Already gone; nothing left to clean up.
    }
    return true;
  }

  private lockPathFor(taskId: string): string {
    return join(this.root, `${taskId}.lifecycle.lock`);
  }
}

function randomLockToken(): string {
  return Math.random().toString(36).slice(2);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Reads back the assignmentLockAtMerge field finalize() persisted into a
// merge-evidence record. Anything other than exactly a well-formed
// LockIdentity shape or a genuine `null` — an absent field on older
// evidence, a malformed value, garbage from a hand-edited store — resolves
// to `null` (nothing to release) rather than throwing: erring toward never
// releasing an assignment lock this call cannot positively identify is the
// same safe-default direction releaseLockIfPresent's own full-identity
// comparison already takes.
function parsePersistedLockIdentity(value: unknown): LockIdentity | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const { lockId, ownerId, runId, canonicalBranch } = candidate;
  if (
    typeof lockId === "string" &&
    lockId.length > 0 &&
    typeof ownerId === "string" &&
    ownerId.length > 0 &&
    typeof runId === "string" &&
    runId.length > 0 &&
    typeof canonicalBranch === "string" &&
    canonicalBranch.length > 0
  ) {
    return { lockId, ownerId, runId, canonicalBranch };
  }
  return null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/* ------------------------------------------------------------------------ */
/* GitHub pull-request merge adapter                                        */
/* ------------------------------------------------------------------------ */

export interface GitHubControlledMergePullRequestOperationsOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Concrete `ControlledMergePullRequestPort` implementation over the GitHub
 * REST API. `findPullRequestsByHead` searches all pull-request states (not
 * only `open`) and returns every match (not only the most recent) so a
 * pull request that was already merged — by this controller's own prior,
 * interrupted attempt or out of band — is still discovered and its
 * `merged`/`merge_commit_sha` fields trusted even when an unrelated, more
 * recently created PR (for example a stray closed one against a different
 * base) shares the same head branch. `mergePullRequest` passes the expected
 * head SHA to GitHub's own merge endpoint, which atomically rejects the
 * request server-side (HTTP 409) if the pull request's head has moved —
 * mapped to `HEAD_CHANGED` here rather than a generic provider failure.
 */
export class GitHubControlledMergePullRequestOperations implements ControlledMergePullRequestPort {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GitHubControlledMergePullRequestOperationsOptions) {
    if (options.owner.trim().length === 0) throw new RangeError("GitHub merge adapter owner must be non-empty.");
    if (options.repo.trim().length === 0) throw new RangeError("GitHub merge adapter repo must be non-empty.");
    if (options.token.trim().length === 0) throw new RangeError("GitHub merge adapter token must be non-empty.");
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // Returns every pull request matching this head branch, in any state, in
  // descending creation order — never only the single most recent one, and
  // never only the first page — so a caller scanning for a specific
  // already-merged candidate (see ControlledMergeController's own use) can
  // never have that candidate hidden behind an unrelated, more-recently-
  // created PR sharing the same branch, nor behind page-100-plus of a
  // long-lived reused branch's history. Pages at GitHub's own maximum
  // per_page (100) and keeps requesting subsequent pages until a
  // less-than-full page confirms there is nothing left to fetch.
  async findPullRequestsByHead(head: string): Promise<readonly ControlledMergePullRequestRecord[]> {
    const perPage = 100;
    const results: ControlledMergePullRequestRecord[] = [];
    for (let page = 1; ; page += 1) {
      const query = `state=all&head=${encodeURIComponent(`${this.owner}:${head}`)}&sort=created&direction=desc&per_page=${perPage}&page=${page}`;
      const data = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls?${query}`);
      if (!Array.isArray(data)) {
        throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pulls list response was not an array.");
      }
      for (const entry of data) {
        results.push(toRecord(entry));
      }
      if (data.length < perPage) break;
    }
    return Object.freeze(results);
  }

  // Fetches the single pull request identified by number, unambiguously —
  // never a "most recent for this branch" guess — so a caller that already
  // knows exactly which PR it means (the pre-merge recheck, which already
  // has readiness's own selected pullRequestNumber) can never be misled by
  // an unrelated PR sharing the same head branch.
  async getPullRequest(number: number): Promise<ControlledMergePullRequestRecord | null> {
    let data: unknown;
    try {
      data = await this.request("GET", `/repos/${this.owner}/${this.repo}/pulls/${number}`);
    } catch (error: unknown) {
      if (error instanceof PullRequestProviderError && error.code === "NOT_FOUND") return null;
      throw error;
    }
    return toRecord(data);
  }

  async mergePullRequest(params: MergePullRequestParams): Promise<ControlledMergeProviderResult> {
    const data = await this.request("PUT", `/repos/${this.owner}/${this.repo}/pulls/${params.number}/merge`, {
      sha: params.expectedHeadSha,
    });
    if (!isObject(data) || typeof data.merged !== "boolean" || typeof data.message !== "string") {
      throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request merge response is missing required fields.");
    }
    const sha = data.sha;
    if (data.merged && (typeof sha !== "string" || sha.length === 0)) {
      throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request merge response reported merged=true with no sha.");
    }
    return Object.freeze({ merged: data.merged, sha: typeof sha === "string" ? sha : "", message: data.message });
  }

  private async request(method: string, path: string, jsonBody?: Record<string, unknown>): Promise<unknown> {
    const init: IptFetchInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "iptfantasyfootball-control-plane",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (jsonBody !== undefined) {
      init.body = JSON.stringify(jsonBody);
    }

    let response: IptFetchResponse;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, init);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PullRequestProviderError("NETWORK_FAILED", `GitHub request failed: ${detail}`);
    }

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) {
      return data;
    }

    if (response.status === 409) {
      throw new ControlledMergeError(
        "HEAD_CHANGED",
        `GitHub rejected the merge because the pull request head no longer matches the expected SHA: ${extractMessage(data) ?? "HTTP 409"}`,
      );
    }

    const message = extractMessage(data) ?? `HTTP ${response.status}`;
    throw new PullRequestProviderError(
      mapStatus(response.status, message),
      `GitHub pull-request merge request failed (${response.status}): ${message}`,
      response.status,
    );
  }
}

function mapStatus(status: number, message: string): "AUTH_FAILED" | "NOT_FOUND" | "VALIDATION_FAILED" | "RATE_LIMITED" | "PROVIDER_ERROR" {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return /rate limit/i.test(message) ? "RATE_LIMITED" : "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 405 || status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

function extractMessage(data: unknown): string | null {
  return isObject(data) && typeof data.message === "string" ? data.message : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// GitHub's "List pull requests" response (used by findPullRequestsByHead, so
// that an already-merged PR is discoverable at all via state=all) exposes
// `merged_at`, not the `merged` boolean field — that field is only present
// on the "Get a pull request" single-resource response. Deriving `merged`
// from `merged_at !== null` works identically against both response shapes,
// whereas requiring a `merged` boolean would reject every real list-endpoint
// result as malformed.
function toRecord(raw: unknown): ControlledMergePullRequestRecord {
  if (!isObject(raw)) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response was not an object.");
  }
  const number = raw.number;
  const headSha = isObject(raw.head) ? raw.head.sha : undefined;
  const baseRef = isObject(raw.base) ? raw.base.ref : undefined;
  const state = raw.state;
  const mergedAt = raw.merged_at;
  const mergeCommitSha = raw.merge_commit_sha;
  if (
    typeof number !== "number" ||
    typeof headSha !== "string" ||
    typeof baseRef !== "string" ||
    (state !== "open" && state !== "closed") ||
    (mergedAt !== null && typeof mergedAt !== "string") ||
    (mergeCommitSha !== null && mergeCommitSha !== undefined && typeof mergeCommitSha !== "string")
  ) {
    throw new PullRequestProviderError("PROVIDER_ERROR", "GitHub pull-request response is missing required fields.");
  }
  return Object.freeze({
    number,
    headSha,
    baseRef,
    state,
    merged: typeof mergedAt === "string",
    mergeCommitSha: typeof mergeCommitSha === "string" ? mergeCommitSha : null,
  });
}

/* ------------------------------------------------------------------------ */
/* Local composition root                                                    */
/* ------------------------------------------------------------------------ */

export interface LocalControlledMergeOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly integrationTarget?: string;
  readonly requiredCiChecks?: readonly string[];
}

/**
 * Local composition root, mirroring BOOT-024's own `createLocalMergeReadinessPolicyEngine`.
 * Shares the same task registry, Git branch adapter, `.agent/state/lifecycle`
 * and `.agent/state/evidence` stores every earlier gate uses, reuses
 * `.agent/state/assignments` (BOOT-010's own lock root), and wires a real
 * GitHub-calling `ControlledMergePullRequestPort` adapter.
 */
export async function createLocalControlledMergeController(
  repositoryRoot: string,
  options: LocalControlledMergeOptions,
): Promise<ControlledMergeController> {
  const registry = await loadTaskRegistry({ repositoryRoot });
  const branchLifecycle = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repositoryRoot));
  const stateRoot = join(repositoryRoot, LOCAL_AGENT_STATE_RELATIVE_PATH);
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const evidenceStore = new FileEvidenceStore(join(stateRoot, "evidence"), { repositoryRoot });
  const stateStore = new FileControlledMergeStateStore(lifecycleRoot);
  const taskLock = new FileControlledMergeTaskLock(lifecycleRoot);
  const lockStore = new FileAssignmentLockStore(join(stateRoot, "assignments"));
  const providerOptions = {
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  const mergeReadiness = await createLocalMergeReadinessPolicyEngine(repositoryRoot, {
    ...providerOptions,
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
    ...(options.requiredCiChecks !== undefined ? { requiredCiChecks: options.requiredCiChecks } : {}),
  });
  const pullRequests = new GitHubControlledMergePullRequestOperations(providerOptions);
  return new ControlledMergeController({
    registry,
    stateStore,
    taskLock,
    branchLifecycle,
    mergeReadiness,
    evidenceStore,
    lockStore,
    pullRequests,
    ...(options.integrationTarget !== undefined ? { integrationTarget: options.integrationTarget } : {}),
  });
}

function normalizeBranchError(taskId: string, error: unknown): ControlledMergeError {
  if (error instanceof BranchLifecycleError) {
    return new ControlledMergeError("BRANCH_REJECTED", `Cannot merge '${taskId}': ${error.code}: ${error.message}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ControlledMergeError("BRANCH_REJECTED", `Cannot merge '${taskId}': ${detail}`);
}

function normalizeProviderError(taskId: string, error: unknown): ControlledMergeError {
  if (error instanceof ControlledMergeError) {
    return error;
  }
  if (error instanceof PullRequestProviderError) {
    return new ControlledMergeError(
      "MERGE_PROVIDER_FAILED",
      `Task '${taskId}' pull-request provider request failed: ${error.code}: ${error.message}`,
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new ControlledMergeError("MERGE_PROVIDER_FAILED", `Task '${taskId}' pull-request provider request failed: ${detail}`);
}

function validateRequest(request: ControlledMergeRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge taskId must be a schema-valid task identifier.", false);
  }
  if (request.actorId.trim().length === 0 || request.actorId !== request.actorId.trim()) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge actorId must be non-empty and trimmed.", false);
  }
  if (request.runId.trim().length === 0 || request.runId !== request.runId.trim()) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge runId must be non-empty and trimmed.", false);
  }
  // Rejected strictly, and before any provider call: a loosely-parsed
  // timestamp (missing a timezone offset/Z, or an out-of-range calendar
  // component like Feb 29 on a non-leap year, day 31 of a 30-day month, or
  // hour 24 — all of which Date.parse() silently rolls forward rather than
  // rejecting) would otherwise pass here, let the irreversible merge
  // provider call proceed, and only be discovered as invalid later when
  // schemas/v1/merge-evidence.schema.json's stricter component-level check
  // rejects it at evidence-record time — after the merge already happened.
  if (!isValidRfc3339DateTime(request.occurredAt)) {
    throw new ControlledMergeError("INVALID_REQUEST", "Controlled merge occurredAt must be a valid RFC 3339 date-time.", false);
  }
}

// Mirrors control-plane.evidence-store's own isValidRfc3339DateTime exactly
// (including the timezone-offset-range check, since both share this exact
// gap otherwise): the regex plus Date.parse() alone cannot reject an
// out-of-range calendar date (Date.parse silently rolls Feb 30 forward into
// March) or an out-of-range numeric offset like "+24:00"/"+01:60", so
// component ranges are checked explicitly for the date, local time, and any
// numeric offset alike.
function isValidRfc3339DateTime(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day < 1 || day > maxDay) return false;
  if (hour > 23) return false;
  if (minute > 59) return false;
  // RFC 3339's grammar allows a seconds value of 60 for a leap second, but
  // only ever at the instant 23:59:60 UTC — never any other minute/hour — so
  // a bare `second > 59` upper bound would either reject every real
  // leap-second timestamp (too strict) or, if simply raised to 60
  // everywhere, accept "12:00:60" as if any minute could run long (too
  // loose). This checks both without needing an actual historical
  // leap-second calendar.
  if (second > 60) return false;

  let offsetMinutesTotal = 0;
  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23) return false;
    if (offsetMinute > 59) return false;
    offsetMinutesTotal = (match[7] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  if (second === 60) {
    // A leap second carrying a nonzero offset need not read local 23:59:
    // RFC 3339's own equivalent form "1990-12-31T15:59:60-08:00" is the
    // same instant as "1990-12-31T23:59:60Z", so placement is checked
    // against the UTC-equivalent hour/minute, not the local one.
    const utcMinutesOfDay = (((hour * 60 + minute - offsetMinutesTotal) % 1440) + 1440) % 1440;
    if (Math.floor(utcMinutesOfDay / 60) !== 23 || utcMinutesOfDay % 60 !== 59) return false;
  }

  return true;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function latestHistoryEventToState(record: LifecycleRecord, toState: TaskLifecycleState): LifecycleHistoryEvent | null {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const event = record.history[index];
    if (event !== undefined && event.toState === toState) {
      return event;
    }
  }
  return null;
}

function parseEvidenceRef(ref: string): { readonly lineageId: string; readonly sequence: number } | null {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return null;
  const sequence = Number(ref.slice(at + 1));
  if (!Number.isInteger(sequence) || sequence <= 0) return null;
  return { lineageId: ref.slice(0, at), sequence };
}

function isLifecycleState(value: unknown): value is TaskLifecycleState {
  return typeof value === "string" && (TASK_LIFECYCLE_STATES as readonly string[]).includes(value);
}
