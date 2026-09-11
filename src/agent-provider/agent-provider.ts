import type { ContextPackage, ContextRole } from "../context-compiler/index.js";
import {
  FINDING_SEVERITIES,
  REVIEW_OUTCOMES,
  REVIEW_ROLES,
  type ReviewFinding,
  type ReviewNonPassDetail,
  type ReviewOutcome,
} from "../review-framework/index.js";

const TASK_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;

/**
 * BOOT-026 reuses the exact BOOT-012 `ContextRole` union rather than
 * redefining an equivalent enum: an agent run's role is always the role its
 * compiled context package was built for, and the two must never be able to
 * drift apart structurally even though this module never imports
 * `control-plane.review-framework`'s own `ReviewRole` alias for the same five
 * values.
 */
export type AgentRunnerRole = ContextRole;

/**
 * The five roles a run request may target, reusing `control-plane.review-
 * framework`'s own `REVIEW_ROLES` runtime list rather than redeclaring the
 * same five literal strings a third time in this repository. `ReviewRole`
 * and `ContextRole` are separately declared unions with identical literal
 * members, so this array is structurally valid for `AgentRunnerRole` even
 * though the two type names never alias each other.
 */
export const AGENT_RUNNER_ROLES: readonly AgentRunnerRole[] = REVIEW_ROLES;

export const AGENT_NETWORK_ACCESS_LEVELS = ["none", "restricted", "full"] as const;
export type AgentNetworkAccess = (typeof AGENT_NETWORK_ACCESS_LEVELS)[number];

/**
 * Declares which tools/capabilities a provider run is permitted to use and
 * how much network access it may have. BOOT-026 defines this envelope only;
 * enforcing it against a concrete vendor's own tool/permission model is a
 * real-provider-adapter concern explicitly out of scope here.
 */
export interface AgentToolPermissionPolicy {
  readonly allowedTools: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly networkAccess: AgentNetworkAccess;
}

/**
 * Capability discovery: what an `AgentProvider` can do, independent of any
 * one run request. An orchestrator uses this to decide whether a provider
 * can even attempt a given role, and whether it needs to layer its own
 * timeout/cancellation enforcement on top (`AgentRunner` always does, never
 * trusting these flags as a substitute for its own enforcement).
 */
export interface AgentProviderCapabilities {
  readonly providerId: string;
  readonly supportedRoles: readonly AgentRunnerRole[];
  readonly supportsCancellation: boolean;
  readonly supportsTimeout: boolean;
}

/**
 * The immutable identity and inputs of one agent/automation role invocation.
 * `contextPackage` is the exact BOOT-012 `ContextPackage` the run must be
 * bound to; `AgentRunner.run()` rejects any request whose `contextPackage`
 * does not match the request's own `taskId`/`role`/`revisionIdentity` before
 * a provider is ever called (see `CONTEXT_PACKAGE_MISMATCH`). `signal` is the
 * standard Node/Web `AbortSignal` global, not a repository-invented
 * cancellation-token type, so a caller can compose this with any other
 * `AbortSignal`-based cancellation already in use elsewhere.
 */
export interface AgentRunRequest {
  readonly taskId: string;
  readonly role: AgentRunnerRole;
  readonly revisionIdentity: string;
  readonly runId: string;
  readonly actorId: string;
  readonly contextPackage: ContextPackage;
  readonly toolPermissionPolicy: AgentToolPermissionPolicy;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * The structured result of one agent run. Every field `ReviewSubmissionRequest`
 * (BOOT-017) needs to record this run as a review/developer-handoff judgment
 * is present here without loss: `taskId`/`role`/`revisionIdentity`/`runId`
 * together reproduce the exact `${taskId}:${role}:${revisionIdentity}:${runId}`
 * composite identity `ReviewFramework.submit()` builds for its own
 * `reviewId`, and `outcome`/`details`/`findings`/`evidenceRefs`/`nonPass`
 * reuse `control-plane.review-framework`'s own types directly rather than
 * parallel, independently-drifting duplicates. This module never calls
 * `ReviewFramework.submit()` itself — that composition remains a future
 * orchestrator's job (BOOT-027 onward).
 */
export interface AgentRunResult {
  readonly runId: string;
  readonly providerId: string;
  readonly taskId: string;
  readonly role: AgentRunnerRole;
  readonly revisionIdentity: string;
  readonly outcome: ReviewOutcome;
  readonly details: Readonly<Record<string, unknown>>;
  readonly findings: readonly ReviewFinding[];
  readonly evidenceRefs: readonly string[];
  readonly nonPass?: ReviewNonPassDetail;
  readonly occurredAt: string;
}

/**
 * The pluggable, vendor-agnostic port a real provider adapter (ChatGPT,
 * Codex, or any other vendor) implements later. BOOT-026 ships no such
 * adapter — only this interface and the in-memory `FakeAgentProvider` below.
 * A provider may throw any raw error from `run()`; `AgentRunner` is the layer
 * that normalizes it into a typed `AgentProviderError`, so no orchestrator
 * code ever needs to know which concrete provider produced a failure.
 */
export interface AgentProvider {
  readonly providerId: string;
  capabilities(): AgentProviderCapabilities;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export type AgentProviderErrorCode =
  | "INVALID_REQUEST"
  | "CONTEXT_PACKAGE_MISMATCH"
  | "UNSUPPORTED_ROLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROVIDER_ERROR"
  | "MALFORMED_RESULT";

export class AgentProviderError extends Error {
  readonly code: AgentProviderErrorCode;
  readonly recoverable: boolean;
  readonly providerId?: string;

  constructor(code: AgentProviderErrorCode, message: string, recoverable = true, providerId?: string) {
    super(message);
    this.name = "AgentProviderError";
    this.code = code;
    this.recoverable = recoverable;
    if (providerId !== undefined) {
      this.providerId = providerId;
    }
  }
}

export interface AgentRunnerDependencies {
  readonly provider: AgentProvider;
}

/**
 * BOOT-026 orchestrator-facing wrapper around one injected `AgentProvider`
 * (analogous to `ReviewFramework` wrapping an injected evidence store, or
 * `ControlledMergeController` wrapping its injected ports). `run()`:
 *
 * 1. validates the request's own shape (`INVALID_REQUEST`);
 * 2. rejects a `contextPackage` that does not match the request's own
 *    `taskId`/`role`/`revisionIdentity` (`CONTEXT_PACKAGE_MISMATCH`), before
 *    the provider is ever called — mirroring `ReviewFramework.submit()`'s own
 *    identical check exactly, since the same invariant applies here;
 * 3. rejects a role the provider's own `capabilities()` does not list
 *    (`UNSUPPORTED_ROLE`);
 * 4. rejects a request whose `signal` is already aborted, without ever
 *    calling the provider (`CANCELLED`);
 * 5. races the provider's `run()` promise against a real timer (when
 *    `timeoutMs` is set) and the `signal` (when supplied) — never trusting
 *    the provider to self-enforce either — normalizing a timeout to
 *    `TIMEOUT` (recoverable) and a cancellation to `CANCELLED`
 *    (not recoverable, since a cancelled run should not be blindly retried
 *    without a fresh decision);
 * 6. normalizes any other raw provider failure to `PROVIDER_ERROR`;
 * 7. validates the provider's returned result is well-formed and bound to
 *    the exact request that produced it, rejecting a mismatched or
 *    malformed one as `MALFORMED_RESULT` before ever handing it back to the
 *    caller.
 *
 * `AgentRunner` decides no role-specific judgment itself, calls no real AI
 * vendor, and runs no sequential multi-role orchestration; those remain
 * owned by a real provider adapter and by BOOT-027 onward respectively.
 */
export class AgentRunner {
  constructor(private readonly dependencies: AgentRunnerDependencies) {}

  capabilities(): AgentProviderCapabilities {
    return this.dependencies.provider.capabilities();
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    validateRequest(request);

    const contextPackage = request.contextPackage;
    if (contextPackage.taskId !== request.taskId) {
      throw new AgentProviderError(
        "CONTEXT_PACKAGE_MISMATCH",
        `Context package taskId '${contextPackage.taskId}' does not match run request taskId '${request.taskId}'.`,
        false,
      );
    }
    if (contextPackage.role !== request.role) {
      throw new AgentProviderError(
        "CONTEXT_PACKAGE_MISMATCH",
        `Context package role '${contextPackage.role}' does not match run request role '${request.role}'.`,
        false,
      );
    }
    if (contextPackage.sourceRevision !== request.revisionIdentity) {
      throw new AgentProviderError(
        "CONTEXT_PACKAGE_MISMATCH",
        `Context package sourceRevision '${contextPackage.sourceRevision}' does not match run request revisionIdentity '${request.revisionIdentity}'.`,
        false,
      );
    }

    const providerId = this.dependencies.provider.providerId;

    let providerCapabilities: AgentProviderCapabilities;
    try {
      providerCapabilities = this.dependencies.provider.capabilities();
    } catch (error: unknown) {
      throw normalizeProviderError(error, providerId);
    }
    if (!providerCapabilities.supportedRoles.includes(request.role)) {
      throw new AgentProviderError(
        "UNSUPPORTED_ROLE",
        `Provider '${providerId}' does not support role '${request.role}'.`,
        false,
        providerId,
      );
    }

    if (request.signal?.aborted === true) {
      throw new AgentProviderError(
        "CANCELLED",
        `Agent run '${request.runId}' for task '${request.taskId}' role '${request.role}' was already cancelled before it started.`,
        false,
        providerId,
      );
    }

    const rawResult = await this.invokeProvider(request, providerId);
    return validateResult(rawResult, request, providerId);
  }

  private async invokeProvider(request: AgentRunRequest, providerId: string): Promise<unknown> {
    const racers: Array<Promise<unknown>> = [
      Promise.resolve()
        .then(() => this.dependencies.provider.run(request))
        .catch((error: unknown) => {
          throw normalizeProviderError(error, providerId);
        }),
    ];

    // Deliberately not `.unref()`ed, unlike this repository's other
    // background/heartbeat timers (validation-framework, controlled-merge):
    // this timer is not a background safety net alongside other work that
    // keeps the process alive on its own — it is the entire mechanism by
    // which run()'s own TIMEOUT guarantee is kept. A provider whose run()
    // call genuinely never touches the event loop again (the exact case
    // FakeAgentProvider.hangIndefinitely() exists to exercise) leaves this
    // timer as the only remaining scheduled work; unref'ing it would let the
    // process exit before the timer ever fires, silently breaking the
    // documented timeout contract instead of enforcing it.
    let timer: IptTimeoutHandle | undefined;
    if (request.timeoutMs !== undefined) {
      const timeoutMs = request.timeoutMs;
      racers.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new AgentProviderError(
                "TIMEOUT",
                `Agent run '${request.runId}' for task '${request.taskId}' role '${request.role}' timed out after ${timeoutMs}ms.`,
                true,
                providerId,
              ),
            );
          }, timeoutMs);
        }),
      );
    }

    let onAbort: (() => void) | undefined;
    if (request.signal !== undefined) {
      const signal = request.signal;
      racers.push(
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            reject(
              new AgentProviderError(
                "CANCELLED",
                `Agent run '${request.runId}' for task '${request.taskId}' role '${request.role}' was cancelled.`,
                false,
                providerId,
              ),
            );
          };
          signal.addEventListener("abort", onAbort);
        }),
      );
    }

    try {
      return await Promise.race(racers);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function normalizeProviderError(error: unknown, providerId: string): AgentProviderError {
  if (error instanceof AgentProviderError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AgentProviderError("PROVIDER_ERROR", `Agent provider '${providerId}' run() failed: ${message}`, true, providerId);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function validateRequest(request: AgentRunRequest): void {
  if (!TASK_ID_PATTERN.test(request.taskId)) {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run taskId must be a schema-valid task identifier.", false);
  }
  if (!(AGENT_RUNNER_ROLES as readonly string[]).includes(request.role)) {
    throw new AgentProviderError("INVALID_REQUEST", `Agent run role '${String(request.role)}' is not a recognized role.`, false);
  }
  if (!isNonEmptyTrimmedString(request.revisionIdentity)) {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run revisionIdentity must be non-empty and trimmed.", false);
  }
  if (!isNonEmptyTrimmedString(request.runId)) {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run runId must be non-empty and trimmed.", false);
  }
  if (!isNonEmptyTrimmedString(request.actorId)) {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run actorId must be non-empty and trimmed.", false);
  }
  validateToolPermissionPolicy(request.toolPermissionPolicy);
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run timeoutMs must be a positive integer when provided.", false);
  }
  if (request.signal !== undefined && typeof request.signal.aborted !== "boolean") {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run signal must be an AbortSignal when provided.", false);
  }
}

function validateToolPermissionPolicy(policy: AgentToolPermissionPolicy): void {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new AgentProviderError("INVALID_REQUEST", "Agent run toolPermissionPolicy must be an object.", false);
  }
  if (!Array.isArray(policy.allowedTools) || policy.allowedTools.some((tool) => !isNonEmptyTrimmedString(tool))) {
    throw new AgentProviderError(
      "INVALID_REQUEST",
      "Agent run toolPermissionPolicy.allowedTools must be an array of non-empty trimmed strings.",
      false,
    );
  }
  if (
    policy.deniedTools !== undefined &&
    (!Array.isArray(policy.deniedTools) || policy.deniedTools.some((tool) => !isNonEmptyTrimmedString(tool)))
  ) {
    throw new AgentProviderError(
      "INVALID_REQUEST",
      "Agent run toolPermissionPolicy.deniedTools must be an array of non-empty trimmed strings when provided.",
      false,
    );
  }
  if (!(AGENT_NETWORK_ACCESS_LEVELS as readonly string[]).includes(policy.networkAccess)) {
    throw new AgentProviderError(
      "INVALID_REQUEST",
      `Agent run toolPermissionPolicy.networkAccess '${String(policy.networkAccess)}' is not recognized.`,
      false,
    );
  }
}

function malformed(providerId: string, field: string): AgentProviderError {
  return new AgentProviderError(
    "MALFORMED_RESULT",
    `Agent provider '${providerId}' run() result has a missing or invalid '${field}' field.`,
    false,
    providerId,
  );
}

/**
 * A provider's declared TypeScript return type is never trusted uncritically
 * (the same "never trust a single field comparison, verify the whole shape"
 * culture as `ControlledMergeController`'s own evidence-payload revalidation):
 * every field `ReviewSubmissionRequest` would need to record this run is
 * checked to actually be present, well-typed, and bound to the exact request
 * that produced it before `AgentRunner.run()` ever returns it to a caller.
 */
function validateResult(rawResult: unknown, request: AgentRunRequest, providerId: string): AgentRunResult {
  if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
    throw malformed(providerId, "result");
  }
  const candidate = rawResult as Record<string, unknown>;

  if (candidate.taskId !== request.taskId) throw malformed(providerId, "taskId");
  if (candidate.role !== request.role) throw malformed(providerId, "role");
  if (candidate.revisionIdentity !== request.revisionIdentity) throw malformed(providerId, "revisionIdentity");
  if (candidate.runId !== request.runId) throw malformed(providerId, "runId");
  if (candidate.providerId !== providerId) throw malformed(providerId, "providerId");
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(candidate.outcome as string)) {
    throw malformed(providerId, "outcome");
  }
  if (typeof candidate.details !== "object" || candidate.details === null || Array.isArray(candidate.details)) {
    throw malformed(providerId, "details");
  }
  if (!Array.isArray(candidate.findings) || candidate.findings.some((finding) => !isValidFinding(finding))) {
    throw malformed(providerId, "findings");
  }
  if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.some((ref) => typeof ref !== "string")) {
    throw malformed(providerId, "evidenceRefs");
  }
  if (candidate.outcome !== "PASS" && !isValidNonPass(candidate.nonPass)) {
    throw malformed(providerId, "nonPass");
  }
  if (
    typeof candidate.occurredAt !== "string" ||
    Number.isNaN(Date.parse(candidate.occurredAt)) ||
    !candidate.occurredAt.includes("T")
  ) {
    throw malformed(providerId, "occurredAt");
  }

  return Object.freeze({ ...candidate }) as unknown as AgentRunResult;
}

function isValidFinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(finding.findingId) &&
    (FINDING_SEVERITIES as readonly string[]).includes(finding.severity as string) &&
    typeof finding.observed === "string" &&
    finding.observed.trim().length > 0 &&
    typeof finding.expected === "string" &&
    finding.expected.trim().length > 0
  );
}

function isValidNonPass(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const nonPass = value as Record<string, unknown>;
  return isNonEmptyTrimmedString(nonPass.reason) && isNonEmptyTrimmedString(nonPass.remediation);
}

export type FakeAgentRunHandler = (request: AgentRunRequest) => AgentRunResult | Promise<AgentRunResult>;

export interface FakeAgentProviderOptions {
  readonly providerId?: string;
  readonly supportedRoles?: readonly AgentRunnerRole[];
  readonly supportsCancellation?: boolean;
  readonly supportsTimeout?: boolean;
}

/**
 * BOOT-026's in-memory, network-free, filesystem-free test provider. Test
 * code configures exactly one of: a queue of canned `AgentRunResult`s
 * (`enqueueResult`), a handler function (`setHandler`), a raw error to throw
 * on the next `run()` call (`queueError`), an artificial delay before
 * resolving (`resolveAfterDelay`, to exercise cancellation racing a slow
 * provider), or a promise that never settles at all (`hangIndefinitely`, to
 * exercise `AgentRunner`'s own timeout without any real clock dependency in
 * the provider itself). Every accepted `request` is also recorded in
 * `requests` so a test can assert exactly what an `AgentRunner` handed the
 * provider.
 */
export class FakeAgentProvider implements AgentProvider {
  readonly providerId: string;
  readonly requests: AgentRunRequest[] = [];

  private readonly capabilitiesValue: AgentProviderCapabilities;
  private readonly queuedResults: AgentRunResult[] = [];
  private handler: FakeAgentRunHandler | undefined;
  private queuedError: unknown;
  private hasQueuedError = false;
  private hangForever = false;
  private delayMs = 0;

  constructor(options: FakeAgentProviderOptions = {}) {
    this.providerId = options.providerId ?? "fake-agent-provider";
    this.capabilitiesValue = Object.freeze({
      providerId: this.providerId,
      supportedRoles: options.supportedRoles ?? AGENT_RUNNER_ROLES,
      supportsCancellation: options.supportsCancellation ?? true,
      supportsTimeout: options.supportsTimeout ?? true,
    });
  }

  capabilities(): AgentProviderCapabilities {
    return this.capabilitiesValue;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);

    if (this.delayMs > 0) {
      await delay(this.delayMs);
    }
    if (this.hangForever) {
      return new Promise<AgentRunResult>(() => {
        // Deliberately never resolves or rejects, so a caller can exercise
        // AgentRunner's own timeout enforcement without any real provider
        // ever taking this long.
      });
    }
    if (this.hasQueuedError) {
      this.hasQueuedError = false;
      throw this.queuedError;
    }
    if (this.handler !== undefined) {
      return await this.handler(request);
    }
    const next = this.queuedResults.shift();
    if (next === undefined) {
      throw new Error(
        `FakeAgentProvider '${this.providerId}' has no queued result, handler, or error configured for this run().`,
      );
    }
    return next;
  }

  enqueueResult(result: AgentRunResult): void {
    this.queuedResults.push(result);
  }

  setHandler(handler: FakeAgentRunHandler | undefined): void {
    this.handler = handler;
  }

  queueError(error: unknown): void {
    this.queuedError = error;
    this.hasQueuedError = true;
  }

  resolveAfterDelay(ms: number): void {
    this.delayMs = ms;
  }

  hangIndefinitely(): void {
    this.hangForever = true;
  }
}

function delay(ms: number): Promise<void> {
  // Not `.unref()`ed, for the same reason as AgentRunner's own timeout timer:
  // a test using resolveAfterDelay() with nothing else keeping the event
  // loop alive must still reliably resolve after `ms`, not race process exit.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
