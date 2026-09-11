import assert from "node:assert/strict";
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
  assert.equal(provider.requests[0], request);
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
  assert.equal(provider.requests.length, 0);
});

test("a FakeAgentProvider run() with no queued result, handler, or error configured fails loudly rather than hanging silently", async () => {
  const provider = new FakeAgentProvider();
  const runner = new AgentRunner({ provider });

  await assert.rejects(
    () => runner.run(runRequest()),
    (error) => error instanceof AgentProviderError && error.code === "PROVIDER_ERROR",
  );
});
