import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VALIDATOR_TIMEOUT_MS,
  ValidationExecutor,
  ValidationFrameworkError,
} from "../dist/validation-framework/index.js";

function commandValidator(overrides) {
  return {
    kind: "command",
    validatorId: "cmd",
    category: "task-specific",
    required: true,
    command: "node",
    args: ["-e", "process.exit(0)"],
    ...overrides,
  };
}

function functionValidator(overrides) {
  return {
    kind: "function",
    validatorId: "fn",
    category: "task-specific",
    required: true,
    execute: () => ({ status: "PASS" }),
    ...overrides,
  };
}

test("constructor rejects an empty validator set", () => {
  assert.throws(
    () => new ValidationExecutor([]),
    (error) => error instanceof ValidationFrameworkError && error.code === "EMPTY_VALIDATOR_SET",
  );
});

test("constructor rejects duplicate validator ids", () => {
  assert.throws(
    () => new ValidationExecutor([commandValidator({ validatorId: "dup" }), functionValidator({ validatorId: "dup" })]),
    (error) => error instanceof ValidationFrameworkError && error.code === "DUPLICATE_VALIDATOR_ID",
  );
});

test("constructor rejects a malformed validator spec", () => {
  assert.throws(
    () => new ValidationExecutor([commandValidator({ command: "  " })]),
    (error) => error instanceof ValidationFrameworkError && error.code === "INVALID_VALIDATOR_SPEC",
  );
  assert.throws(
    () => new ValidationExecutor([commandValidator({ category: "not-a-category" })]),
    (error) => error instanceof ValidationFrameworkError && error.code === "INVALID_VALIDATOR_SPEC",
  );
  assert.throws(
    () => new ValidationExecutor([functionValidator({ execute: undefined })]),
    (error) => error instanceof ValidationFrameworkError && error.code === "INVALID_VALIDATOR_SPEC",
  );
});

test("all-pass validator set aggregates to PASS", async () => {
  const executor = new ValidationExecutor([
    commandValidator({ validatorId: "a", command: "node", args: ["-e", "process.exit(0)"] }),
    functionValidator({ validatorId: "b", execute: () => ({ status: "PASS", details: "ok" }) }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "PASS");
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((validator) => validator.status === "PASS"));
  assert.ok(result.durationMs >= 0);
  assert.ok(!Number.isNaN(Date.parse(result.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(result.finishedAt)));
});

test("one deterministic fail among passes makes aggregate validation fail, and later validators still run", async () => {
  const executor = new ValidationExecutor([
    commandValidator({ validatorId: "a", command: "node", args: ["-e", "process.exit(0)"] }),
    commandValidator({ validatorId: "b", command: "node", args: ["-e", "process.exit(1)"] }),
    commandValidator({ validatorId: "c", command: "node", args: ["-e", "process.exit(0)"] }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "FAIL");
  assert.deepEqual(result.results.map((validator) => validator.validatorId), ["a", "b", "c"]);
  assert.deepEqual(result.results.map((validator) => validator.status), ["PASS", "FAIL", "PASS"]);
});

test("a validator result carries identity, executor, status, timestamps/duration, and diagnostics", async () => {
  const executor = new ValidationExecutor([
    commandValidator({
      validatorId: "identity-check",
      category: "test",
      required: true,
      command: "node",
      args: ["-e", "console.log('hello'); process.exit(1)"],
    }),
  ]);

  const [result] = (await executor.run()).results;

  assert.equal(result.validatorId, "identity-check");
  assert.equal(result.category, "test");
  assert.equal(result.required, true);
  assert.equal(result.executor, "command:node -e console.log('hello'); process.exit(1)");
  assert.equal(result.status, "FAIL");
  assert.match(result.diagnostics, /hello/);
  assert.ok(!Number.isNaN(Date.parse(result.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(result.finishedAt)));
  assert.ok(result.durationMs >= 0);
});

test("a command that cannot be executed is reported as ERROR, distinct from an assertion FAIL", async () => {
  const executor = new ValidationExecutor([
    commandValidator({ validatorId: "missing-binary", command: "definitely-not-a-real-ipt-command" }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.results[0].status, "ERROR");
});

test("a command validator that exceeds its timeout is reported as ERROR", async () => {
  const executor = new ValidationExecutor([
    commandValidator({
      validatorId: "slow",
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 200,
    }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.results[0].status, "ERROR");
  assert.match(result.results[0].diagnostics, /timed out|signal/i);
});

test("a function validator that throws is reported as ERROR", async () => {
  const executor = new ValidationExecutor([
    functionValidator({
      validatorId: "throws",
      execute: () => {
        throw new Error("boom");
      },
    }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.results[0].status, "ERROR");
  assert.match(result.results[0].diagnostics, /boom/);
});

test("a function validator can fail asynchronously", async () => {
  const executor = new ValidationExecutor([
    functionValidator({
      validatorId: "async-fail",
      execute: async () => ({ status: "FAIL", details: "async assertion failed" }),
    }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "FAIL");
  assert.equal(result.results[0].status, "FAIL");
  assert.equal(result.results[0].diagnostics, "async assertion failed");
});

test("an optional validator failing does not fail the aggregate outcome", async () => {
  const executor = new ValidationExecutor([
    commandValidator({ validatorId: "required-pass", command: "node", args: ["-e", "process.exit(0)"] }),
    commandValidator({
      validatorId: "optional-fail",
      required: false,
      command: "node",
      args: ["-e", "process.exit(1)"],
    }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "PASS");
  assert.equal(result.results.find((validator) => validator.validatorId === "optional-fail").status, "FAIL");
});

test("an optional validator erroring does not fail the aggregate outcome", async () => {
  const executor = new ValidationExecutor([
    commandValidator({ validatorId: "required-pass", command: "node", args: ["-e", "process.exit(0)"] }),
    functionValidator({
      validatorId: "optional-error",
      required: false,
      execute: () => {
        throw new Error("infra hiccup");
      },
    }),
  ]);

  const result = await executor.run();

  assert.equal(result.outcome, "PASS");
  assert.equal(result.results.find((validator) => validator.validatorId === "optional-error").status, "ERROR");
});

test("execution order is deterministic and stable across repeated runs of the same set", async () => {
  const specs = [
    commandValidator({ validatorId: "z", command: "node", args: ["-e", "process.exit(0)"] }),
    functionValidator({ validatorId: "a", execute: () => ({ status: "PASS" }) }),
    commandValidator({ validatorId: "m", command: "node", args: ["-e", "process.exit(0)"] }),
  ];

  const first = await new ValidationExecutor(specs).run();
  const second = await new ValidationExecutor(specs).run();

  const order = ["z", "a", "m"];
  assert.deepEqual(first.results.map((validator) => validator.validatorId), order);
  assert.deepEqual(second.results.map((validator) => validator.validatorId), order);
});

test("the default validator timeout is exported and positive", () => {
  assert.ok(Number.isFinite(DEFAULT_VALIDATOR_TIMEOUT_MS));
  assert.ok(DEFAULT_VALIDATOR_TIMEOUT_MS > 0);
});
