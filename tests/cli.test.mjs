import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { EXIT_CODES, OUTPUT_SCHEMA_VERSION } from "../dist/cli/contracts.js";
import { runCli } from "../dist/cli/core.js";

const cliPath = new URL("../dist/cli/cli.js", import.meta.url);

function spawnCli(args) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], { encoding: "utf8" });
}

test("help describes the control-plane purpose and bootstrap command surface", () => {
  const result = runCli(["help"]);
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.match(result.stdout, /Deterministic, provider-neutral/);
  assert.match(result.stdout, /next/);
  assert.match(result.stdout, /BOOT-008/);
  assert.match(result.stdout, /reserved/);
});

test("version is stable across repeated invocations", () => {
  assert.deepEqual(runCli(["version"]), runCli(["version"]));
});

test("invalid command returns deterministic non-zero usage error", () => {
  const first = runCli(["not-a-command"]);
  const second = runCli(["not-a-command"]);
  assert.deepEqual(first, second);
  assert.equal(first.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(first.stderr, /^USAGE_UNKNOWN_COMMAND:/);
});

test("unknown option is a deterministic usage error", () => {
  const result = runCli(["--wat"]);
  assert.equal(result.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.match(result.stderr, /^USAGE_UNKNOWN_OPTION:/);
});

test("reserved command fails clearly instead of silently succeeding", () => {
  const result = runCli(["next"]);
  assert.equal(result.exitCode, EXIT_CODES.NOT_IMPLEMENTED);
  assert.match(result.stderr, /^COMMAND_NOT_IMPLEMENTED:/);
  assert.match(result.stderr, /BOOT-008/);
});

test("machine-readable success output uses stable envelope", () => {
  const result = runCli(["--json", "version"]);
  assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "ok", "command", "data", "error"]);
  assert.equal(payload.schemaVersion, OUTPUT_SCHEMA_VERSION);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "version");
  assert.equal(payload.error, null);
});

test("machine-readable errors use the same envelope and deterministic exit code", () => {
  const first = runCli(["--json", "not-a-command"]);
  const second = runCli(["--json", "not-a-command"]);
  assert.deepEqual(first, second);
  assert.equal(first.exitCode, EXIT_CODES.USAGE_ERROR);
  assert.equal(first.stderr, "");
  const payload = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(payload), ["schemaVersion", "ok", "command", "data", "error"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.data, null);
  assert.equal(payload.error.code, "USAGE_UNKNOWN_COMMAND");
});

test("process-level help/version/invalid/unimplemented exit behavior matches core contract", () => {
  assert.equal(spawnCli(["help"]).status, EXIT_CODES.SUCCESS);
  assert.equal(spawnCli(["version"]).status, EXIT_CODES.SUCCESS);
  assert.equal(spawnCli(["not-a-command"]).status, EXIT_CODES.USAGE_ERROR);
  assert.equal(spawnCli(["next"]).status, EXIT_CODES.NOT_IMPLEMENTED);
});

test("CLI shell runs without provider credentials or provider environment", () => {
  const result = spawnSync(process.execPath, [cliPath.pathname, "--json", "help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, EXIT_CODES.SUCCESS);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
