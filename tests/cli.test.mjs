import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { EXIT_CODES, OUTPUT_SCHEMA_VERSION } from "../dist/cli/contracts.js";
import { runCli } from "../dist/cli/core.js";

const cliPath = new URL("../dist/cli/cli.js", import.meta.url);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function spawnCli(args) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], { encoding: "utf8" });
}

function spawnDocumentedJsonCli(args) {
  return spawnSync(npmCommand, ["run", "--silent", "agent", "--", "--json", ...args], {
    encoding: "utf8",
    cwd: new URL("..", import.meta.url),
  });
}

function fakeStartResult(request) {
  return Object.freeze({
    kind: "started",
    taskId: "BOOT-013",
    title: "Developer task-start workflow",
    canonicalBranch: "bootstrap/boot-013-dev-start",
    sourceRevision: "abc123",
    lifecycleState: "IN_DEVELOPMENT",
    branchCreated: true,
    assignment: Object.freeze({
      ownerId: request.ownerId,
      runId: request.runId,
      lockId: `dev-start:BOOT-013:${request.ownerId}:${request.runId}`,
    }),
    acceptanceCriteria: Object.freeze(["safe start", "resume"]),
    contextLocation: "inline",
    context: Object.freeze({
      schemaVersion: "1.0.0",
      role: "Developer",
      taskId: "BOOT-013",
      sourceRevision: "abc123",
      task: Object.freeze({ taskId: "BOOT-013" }),
      artifacts: Object.freeze([]),
      manifest: Object.freeze({ included: Object.freeze([]), excluded: Object.freeze([]) }),
    }),
    nextInstructions: Object.freeze(["work only BOOT-013"]),
  });
}

test("help describes the control-plane purpose and bootstrap command surface", async () => {
  const result = await runCli(["help"]);
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.match(result.stdout, /Deterministic, provider-neutral/);
  assert.match(result.stdout, /next/);
  assert.match(result.stdout, /start/);
  assert.match(result.stdout, /BOOT-013/);
  assert.match(result.stdout, /implemented/);
});

test("version is stable across repeated invocations", async () => {
  assert.deepEqual(await runCli(["version"]), await runCli(["version"]));
});

test("invalid command returns deterministic non-zero usage error", async () => {
  const first = await runCli(["not-a-command"]);
  const second = await runCli(["not-a-command"]);
  assert.deepEqual(first, second);
  assert.equal(first.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(first.stderr, /^USAGE_UNKNOWN_COMMAND:/);
});

test("unknown option is a deterministic usage error", async () => {
  const result = await runCli(["--wat"]);
  assert.equal(result.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(result.stderr, /^USAGE_UNKNOWN_OPTION:/);
});

test("trailing --json controls error rendering regardless of argument order", async () => {
  const result = await runCli(["bogus", "--wat", "--json"]);
  assert.equal(result.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "bogus");
  assert.equal(payload.error.code, "USAGE_UNKNOWN_OPTION");
});

test("still-reserved validation command fails clearly instead of silently succeeding", async () => {
  const result = await runCli(["validate"]);
  assert.equal(result.exitCode, EXIT_CODES.NOT_IMPLEMENTED);
  assert.match(result.stderr, /^COMMAND_NOT_IMPLEMENTED:/);
  assert.match(result.stderr, /BOOT-014\/016/);
});

test("start requires explicit owner and run identity", async () => {
  const missing = await runCli(["start"]);
  const extra = await runCli(["start", "agent-a", "run-1", "extra"]);
  assert.equal(missing.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.equal(extra.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(missing.stderr, /requires exactly <owner-id> <run-id>/);
});

test("start emits task, branch, acceptance/context, and assignment identity", async () => {
  let seenRequest = null;
  const result = await runCli(
    ["--json", "start", "agent-a", "run-1"],
    {
      developerStartWorkflow: {
        start(request) {
          seenRequest = request;
          return fakeStartResult(request);
        },
      },
      now: () => "2026-09-07T19:00:00.000Z",
    },
  );

  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(result.stderr, "");
  assert.deepEqual(seenRequest, {
    ownerId: "agent-a",
    runId: "run-1",
    occurredAt: "2026-09-07T19:00:00.000Z",
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "start");
  assert.equal(payload.data.taskId, "BOOT-013");
  assert.equal(payload.data.canonicalBranch, "bootstrap/boot-013-dev-start");
  assert.deepEqual(payload.data.acceptanceCriteria, ["safe start", "resume"]);
  assert.equal(payload.data.contextLocation, "inline");
  assert.equal(payload.data.context.role, "Developer");
  assert.deepEqual(payload.data.assignment, {
    ownerId: "agent-a",
    runId: "run-1",
    lockId: "dev-start:BOOT-013:agent-a:run-1",
  });
});

test("machine-readable success output uses stable envelope", async () => {
  const result = await runCli(["--json", "version"]);
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "ok", "command", "data", "error"]);
  assert.equal(payload.schemaVersion, OUTPUT_SCHEMA_VERSION);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "version");
  assert.equal(payload.error, null);
});

test("machine-readable errors use the same envelope and deterministic exit code", async () => {
  const first = await runCli(["--json", "not-a-command"]);
  const second = await runCli(["--json", "not-a-command"]);
  assert.deepEqual(first, second);
  assert.equal(first.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.equal(first.stderr, "");
  const payload = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "ok", "command", "data", "error"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.data, null);
  assert.equal(payload.error.code, "USAGE_UNKNOWN_COMMAND");
});

test("documented npm JSON invocation emits exactly one parseable JSON object", () => {
  const result = spawnDocumentedJsonCli(["version"]);
  assert.equal(result.status, EXIT_CODES.SUCCESS);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "version");
  assert.equal(payload.schemaVersion, OUTPUT_SCHEMA_VERSION);
});

test("process-level help/version/invalid/reserved/start-usage/next exit behavior matches core contract", () => {
  assert.equal(spawnCli(["help"]).status, EXIT_CODES.SUCCESS);
  assert.equal(spawnCli(["version"]).status, EXIT_CODES.SUCCESS);
  assert.equal(spawnCli(["not-a-command"]).status, EXIT_CODES.USAGE_ERROR);
  assert.equal(spawnCli(["validate"]).status, EXIT_CODES.NOT_IMPLEMENTED);
  assert.equal(spawnCli(["start"]).status, EXIT_CODES.USAGE_ERROR);
  assert.equal(spawnCli(["next"]).status, EXIT_CODES.SUCCESS);
});

test("CLI shell runs without provider credentials or provider environment", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--json", "help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
