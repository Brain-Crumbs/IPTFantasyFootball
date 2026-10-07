import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  AGENT_RUNNER_ROLES,
  AgentProviderError,
  AgentRunner,
  FakeAgentProvider,
} from "../dist/agent-provider/index.js";

const taskId = "BOOT-026";
const revision = "abcdef1234567890abcdef1234567890abcdef12";
const occurredAt = "2026-09-11T12:00:00Z";

function contextPackage(role, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    role,
    taskId,
    sourceRevision: revision,
    task: { taskId },
    artifacts: [],
    manifest: { included: [], excluded: [] },
    ...overrides,
  };
}

function toolPermissionPolicy(overrides = {}) {
  return {
    allowedTools: ["read_file"],
    networkAccess: "none",
    ...overrides,
  };
}

function runRequest(overrides = {}) {
  const role = overrides.role ?? "Developer";
  return {
    taskId,
    role,
    revisionIdentity: revision,
    runId: "run-1",
    actorId: "orchestrator-1",
    contextPackage: contextPackage(role),
    toolPermissionPolicy: toolPermissionPolicy(),
    ...overrides,
  };
}

function passResult(request, overrides = {}) {
  return {
    runId: request.runId,
    providerId: overrides.providerId ?? "fake-agent-provider",
    taskId: request.taskId,
    role: request.role,
    revisionIdentity: request.revisionIdentity,
    outcome: "PASS",
    details: { summary: "did the work" },
    findings: [],
    evidenceRefs: [],
    occurredAt,
    ...overrides,
  };
}

test("a fake provider produces a successful structured PASS result carrying every field ReviewSubmissionRequest needs", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.enqueueResult(passResult(request));

  const result = await runner.run(request);

  assert.equal(result.outcome, "PASS");
  assert.equal(result.taskId, request.taskId);
  assert.equal(result.role, request.role);
  assert.equal(result.revisionIdentity, request.revisionIdentity);
  assert.equal(result.runId, request.runId);
  assert.equal(result.providerId, provider.providerId);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.evidenceRefs, []);
  // Sufficient to build the same composite identity ReviewFramework.submit()
  // builds for its own reviewId: `${taskId}:${role}:${revisionIdentity}:${runId}`.
  const composite = `${result.taskId}:${result.role}:${result.revisionIdentity}:${result.runId}`;
  assert.equal(composite, `${taskId}:Developer:${revision}:run-1`);
  assert.equal(provider.requests.length, 1);
  assert.notEqual(provider.requests[0], request);
  assert.deepEqual(provider.requests[0], { ...request, signal: provider.requests[0].signal });
  assert.ok(provider.requests[0].signal instanceof AbortSignal);
  assert.equal(provider.requests[0].signal.aborted, false);
  assert.ok(Object.isFrozen(provider.requests[0]));
});

test("a raw provider throw is normalized into a typed, recoverable PROVIDER_ERROR", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  provider.queueError(new Error("vendor exploded"));

  await assert.rejects(
    () => runner.run(runRequest()),
    (error) => {
      assert.ok(error instanceof AgentProviderError);
      assert.equal(error.code, "PROVIDER_ERROR");
      assert.equal(error.recoverable, true);
      assert.equal(error.providerId, "fake-agent-provider");
      assert.match(error.message, /vendor exploded/);
      return true;
    },
  );
});

test("a non-Error thrown by the provider is still normalized into PROVIDER_ERROR", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  provider.queueError("just a string");

  await assert.rejects(
    () => runner.run(runRequest()),
    (error) => error instanceof AgentProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("AgentRunner enforces its own timeout via a real timer race when the provider never settles", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  provider.hangIndefinitely();

  await assert.rejects(
    () => runner.run(runRequest({ timeoutMs: 25 })),
    (error) => {
      assert.ok(error instanceof AgentProviderError);
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});

test("AgentRunner cancels an in-flight run when its signal aborts, independent of provider cooperation", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  provider.resolveAfterDelay(200);
  const controller = new AbortController();
  const request = runRequest({ signal: controller.signal });
  provider.enqueueResult(passResult(request));

  const pending = runner.run(request);
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof AgentProviderError);
    assert.equal(error.code, "CANCELLED");
    assert.equal(error.recoverable, false);
    return true;
  });
});

test("AgentRunner rejects an already-aborted signal without ever calling the provider", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const controller = new AbortController();
  controller.abort();
  const request = runRequest({ signal: controller.signal });

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "CANCELLED" && error.recoverable === false,
  );
  assert.equal(provider.requests.length, 0);
});

test("different roles receive different compiled context identities through the exact same AgentRunner/AgentProvider interface", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  provider.setHandler((request) => passResult(request, { details: { seenRole: request.role } }));

  const developerRequest = runRequest({ role: "Developer" });
  const qaRequest = runRequest({ role: "QA" });

  const developerResult = await runner.run(developerRequest);
  const qaResult = await runner.run(qaRequest);

  assert.equal(developerResult.role, "Developer");
  assert.equal(qaResult.role, "QA");
  assert.notEqual(developerResult.role, qaResult.role);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].contextPackage.role, "Developer");
  assert.equal(provider.requests[1].contextPackage.role, "QA");
  assert.notEqual(provider.requests[0].contextPackage, provider.requests[1].contextPackage);
});

test("every recognized role is representable through AGENT_RUNNER_ROLES", () => {
  assert.deepEqual([...AGENT_RUNNER_ROLES].sort(), ["Architect", "Developer", "MergeController", "QA", "UAT/Product"].sort());
});

test("rejects a context package whose role does not match the run request role", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest({ contextPackage: contextPackage("QA") });

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "CONTEXT_PACKAGE_MISMATCH" && error.recoverable === false,
  );
  assert.equal(provider.requests.length, 0);
});

test("rejects a context package bound to a different revision", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest({
    contextPackage: contextPackage("Developer", { sourceRevision: "0000000000000000000000000000000000000000" }),
  });

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "CONTEXT_PACKAGE_MISMATCH",
  );
});

test("rejects a context package bound to a different task", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest({ contextPackage: contextPackage("Developer", { taskId: "BOOT-999" }) });

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "CONTEXT_PACKAGE_MISMATCH",
  );
});

test("rejects a role the provider's own capabilities() does not support, before ever calling run()", async () => {
  const provider = new FakeAgentProvider({ supportedRoles: ["Developer"] });
  const runner = new AgentRunner({ provider });
  const request = runRequest({ role: "QA" });

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "UNSUPPORTED_ROLE" && error.recoverable === false,
  );
  assert.equal(provider.requests.length, 0);
});

test("capabilities() passes the provider's own capabilities through unchanged", () => {
  const provider = new FakeAgentProvider({ providerId: "custom-provider", supportsCancellation: false });
  const runner = new AgentRunner({ provider });

  const capabilities = runner.capabilities();
  assert.equal(capabilities.providerId, "custom-provider");
  assert.equal(capabilities.supportsCancellation, false);
  assert.deepEqual([...capabilities.supportedRoles].sort(), [...AGENT_RUNNER_ROLES].sort());
});

test("rejects a malformed provider result whose identity fields do not match the request", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.setHandler((req) => passResult(req, { taskId: "BOOT-999" }));

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "MALFORMED_RESULT" && error.recoverable === false,
  );
});

test("rejects a malformed provider result reporting an outcome outside PASS/FAIL/BLOCKED", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.setHandler((req) => passResult(req, { outcome: "APPROVED" }));

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "MALFORMED_RESULT",
  );
});

test("rejects a non-PASS provider result that omits the nonPass reason/remediation detail", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.setHandler((req) => passResult(req, { outcome: "FAIL" }));

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "MALFORMED_RESULT",
  );
});

test("accepts a FAIL provider result that carries a well-formed nonPass detail and findings", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.setHandler((req) =>
    passResult(req, {
      outcome: "FAIL",
      findings: [
        {
          findingId: "agent-1",
          severity: "HIGH",
          observed: "Endpoint returns 500.",
          expected: "Endpoint returns 200.",
        },
      ],
      nonPass: { reason: "Regression found.", remediation: "Fix the endpoint." },
    }),
  );

  const result = await runner.run(request);
  assert.equal(result.outcome, "FAIL");
  assert.equal(result.findings.length, 1);
  assert.equal(result.nonPass.reason, "Regression found.");
});

test("rejects a provider result whose findings entries are malformed", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.setHandler((req) => passResult(req, { findings: [{ findingId: "x" }] }));

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "MALFORMED_RESULT",
  );
});

test("rejects an invalid run request before ever calling the provider", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });

  await assert.rejects(
    () => runner.run(runRequest({ taskId: "not-a-task-id" })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ role: "Owner" })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ revisionIdentity: "" })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ runId: "" })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ actorId: "" })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ toolPermissionPolicy: toolPermissionPolicy({ networkAccess: "unlimited" }) })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ toolPermissionPolicy: toolPermissionPolicy({ allowedTools: "not-an-array" }) })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ timeoutMs: 0 })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ timeoutMs: -5 })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ timeoutMs: 2147483648 })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ contextPackage: undefined })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ contextPackage: null })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    () => runner.run(runRequest({ contextPackage: { role: "Developer", taskId, task: {} } })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  assert.equal(provider.requests.length, 0);
});

test("rejects a timeoutMs at or above setTimeout's own delay ceiling before ever calling the provider, rather than firing an almost-instant spurious timeout", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });

  await assert.rejects(
    () => runner.run(runRequest({ timeoutMs: 2147483647 + 1 })),
    (error) => error instanceof AgentProviderError && error.code === "INVALID_REQUEST",
  );
  assert.equal(provider.requests.length, 0);
});

test("normalizes a provider whose capabilities() returns a malformed shape instead of throwing a raw TypeError", async () => {
  const provider = new FakeAgentProvider();
  provider.capabilities = () => ({ providerId: "fake-agent-provider", supportsCancellation: true, supportsTimeout: true });
  const runner = new AgentRunner({ provider });

  await assert.rejects(
    () => runner.run(runRequest()),
    (error) => error instanceof AgentProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("rejects a provider result whose findings entries carry duplicate findingIds", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  const finding = { findingId: "dup-1", severity: "LOW", observed: "x", expected: "y" };
  provider.setHandler((req) => passResult(req, { findings: [finding, { ...finding }] }));

  await assert.rejects(
    () => runner.run(request),
    (error) => error instanceof AgentProviderError && error.code === "MALFORMED_RESULT",
  );
});

test("validates the request's own identity fields, not a copy the provider mutated in place before resolving", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  provider.setHandler((req) => {
    // A nonconforming provider attempting to rewrite the run identity on the
    // very request object it was handed, before resolving with a result
    // that (without the run()-time freeze) would then match its own tampered
    // copy rather than the identity AgentRunner actually validated.
    try {
      req.taskId = "BOOT-999";
    } catch {
      // Expected in strict mode: the frozen request rejects the write.
    }
    return passResult(req);
  });

  const result = await runner.run(request);
  assert.equal(result.taskId, taskId);
  assert.equal(request.taskId, taskId);
});

test("a caller cannot mutate an AgentRunResult's nested fields after it is returned", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  const request = runRequest();
  const findings = [{ findingId: "f1", severity: "LOW", observed: "x", expected: "y" }];
  const rawResult = passResult(request, { outcome: "FAIL", findings, nonPass: { reason: "r", remediation: "m" } });
  provider.enqueueResult(rawResult);

  const result = await runner.run(request);
  assert.throws(() => {
    result.findings[0].severity = "CRITICAL";
  });
  assert.throws(() => {
    result.details.summary = "tampered";
  });

  // Mutating the provider's own original array/object after the fact must
  // not retroactively change the already-returned, independently-cloned
  // AgentRunResult.
  findings[0].severity = "CRITICAL";
  assert.equal(result.findings[0].severity, "LOW");
});

test("a FakeAgentProvider run() with no queued result, handler, or error configured fails loudly rather than hanging silently", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });

  await assert.rejects(
    () => runner.run(runRequest()),
    (error) => error instanceof AgentProviderError && error.code === "PROVIDER_ERROR",
  );
});

test("timeout aborts the adapter's composed signal without aborting the caller's signal", async () => {
  const provider = new FakeAgentProvider();
  const caller = new AbortController();
  let adapterRequest;
  let adapterReason;
  provider.setHandler((request) => new Promise((_resolve, reject) => {
    adapterRequest = request;
    request.signal.addEventListener("abort", () => {
      adapterReason = request.signal.reason;
      reject(new DOMException("Adapter stopped", "AbortError"));
    }, { once: true });
  }));
  const request = runRequest({ timeoutMs: 10, signal: caller.signal });
  const runner = new AgentRunner({ provider });
  const error = await runner.run(request).then(() => assert.fail("Expected timeout"), (failure) => failure);

  assert.ok(error instanceof AgentProviderError);
  assert.equal(error.code, "TIMEOUT");
  assert.equal(error.recoverable, true);
  assert.notEqual(adapterRequest.signal, caller.signal);
  assert.equal(adapterRequest.contextPackage, request.contextPackage);
  assert.equal(adapterRequest.toolPermissionPolicy, request.toolPermissionPolicy);
  assert.equal(adapterRequest.signal.aborted, true);
  assert.equal(adapterReason, error);
  assert.equal(caller.signal.aborted, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("cancellation propagates to the adapter and cannot be replaced by its abort-listener PASS", async () => {
  const provider = new FakeAgentProvider();
  const caller = new AbortController();
  let adapterSignal;
  provider.setHandler((request) => new Promise((resolve) => {
    adapterSignal = request.signal;
    request.signal.addEventListener("abort", () => resolve(passResult(request)), { once: true });
    caller.abort("User stopped this review");
  }));
  const runner = new AgentRunner({ provider });
  const error = await runner.run(runRequest({ role: "QA", signal: caller.signal }))
    .then(() => assert.fail("Expected cancellation"), (failure) => failure);

  assert.ok(error instanceof AgentProviderError);
  assert.equal(error.code, "CANCELLED");
  assert.equal(error.recoverable, false);
  assert.equal(adapterSignal.aborted, true);
  assert.equal(adapterSignal.reason, error);
  assert.equal(caller.signal.reason, "User stopped this review");
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("cancellation before the invocation microtask skips the provider", async () => {
  const provider = new FakeAgentProvider();
  const caller = new AbortController();
  const pending = new AgentRunner({ provider }).run(runRequest({ signal: caller.signal }));
  caller.abort();
  await assert.rejects(pending, (error) => error instanceof AgentProviderError && error.code === "CANCELLED");
  assert.equal(provider.requests.length, 0);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("settled success and provider failure both remove the caller listener and clear the timeout", async (t) => {
  for (const fails of [false, true]) {
    await t.test(fails ? "provider failure" : "success", async () => {
      const caller = new AbortController();
      const provider = new FakeAgentProvider();
      let adapterSignal;
      provider.setHandler((request) => {
        adapterSignal = request.signal;
        if (fails) throw new Error("Transient provider failure");
        return passResult(request);
      });
      const pending = new AgentRunner({ provider }).run(runRequest({ signal: caller.signal, timeoutMs: 10 }));
      if (fails) await assert.rejects(pending, (error) => error.code === "PROVIDER_ERROR");
      else assert.equal((await pending).outcome, "PASS");
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      caller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(adapterSignal.aborted, false, "Completed runs must not receive a later cancellation/timeout");
    });
  }
});

test("a late provider rejection after timeout is consumed and an explicit retry can succeed", async () => {
  const provider = new FakeAgentProvider();
  let rejectLate;
  provider.setHandler(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
  const runner = new AgentRunner({ provider });
  const request = runRequest({ timeoutMs: 10 });
  await assert.rejects(runner.run(request), (error) => error.code === "TIMEOUT");
  rejectLate(new Error("Late result from the abandoned invocation"));
  provider.setHandler((retryRequest) => passResult(retryRequest));
  const retried = await runner.run(request);
  assert.equal(retried.outcome, "PASS");
  assert.equal(provider.requests.length, 2);
  assert.notEqual(provider.requests[0].signal, provider.requests[1].signal);
  assert.equal(provider.requests[0].signal.aborted, true);
  assert.equal(provider.requests[1].signal.aborted, false);
});

test("AgentRunner preserves typed nonretryable provider failures without automatically retrying", async () => {
  const provider = new FakeAgentProvider();
  const failure = new AgentProviderError("PROVIDER_ERROR", "Permanent adapter configuration error", false, provider.providerId);
  provider.queueError(failure);
  await assert.rejects(new AgentRunner({ provider }).run(runRequest()), (error) => error === failure);
  assert.equal(provider.requests.length, 1);
});

test("semantic QA FAIL and BLOCKED outcomes remain values, never infrastructure errors or automatic retries", async (t) => {
  for (const outcome of ["FAIL", "BLOCKED"]) {
    await t.test(outcome, async () => {
      const provider = new FakeAgentProvider();
      provider.setHandler((request) => passResult(request, {
        outcome,
        nonPass: { reason: "Review prerequisite or expectation is not met.", remediation: "Resolve it before another attempt." },
      }));
      const result = await new AgentRunner({ provider }).run(runRequest({ role: "QA" }));
      assert.equal(result.outcome, outcome);
      assert.equal(provider.requests.length, 1);
    });
  }
});

test("malformed cancellation signals are nonretryable INVALID_REQUEST before adapter invocation", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });
  for (const signal of [null, {}, { aborted: false }, { aborted: false, addEventListener() {} }]) {
    await assert.rejects(runner.run(runRequest({ signal })), (error) =>
      error instanceof AgentProviderError && error.code === "INVALID_REQUEST" && error.recoverable === false);
  }
  assert.equal(provider.requests.length, 0);
});
