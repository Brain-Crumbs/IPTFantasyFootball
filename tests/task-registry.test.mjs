import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TASK_DEFINITIONS_RELATIVE_PATH,
  TASK_SCHEMA_RELATIVE_PATH,
  SUPPORTED_TASK_SCHEMA_VERSION,
  TaskRegistryLoadError,
  loadTaskRegistry,
  loadTaskRegistryFromPaths,
} from "../dist/task-registry/index.js";

const sourceSchemaPath = new URL("../schemas/v1/task.schema.json", import.meta.url);

function validTask(taskId, overrides = {}) {
  return {
    schemaId: "ipt.task",
    schemaVersion: "1.0.0",
    taskId,
    title: `Task ${taskId}`,
    objective: "Exercise deterministic task loading.",
    inScope: ["Task registry fixture"],
    outOfScope: ["Dependency resolution"],
    dependencies: [],
    canonicalBranch: `bootstrap/${taskId.toLowerCase()}-fixture`,
    allowedPaths: ["src/task-registry/"],
    requirements: [],
    acceptanceCriteria: ["Fixture loads."],
    validationPlan: ["Run task registry tests."],
    affectedContracts: ["control-plane.task-registry"],
    requiredReviewRoles: ["Developer"],
    ...overrides,
  };
}

async function createFixtureRepository(files) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ipt-task-registry-"));
  const taskDirectory = join(repositoryRoot, TASK_DEFINITIONS_RELATIVE_PATH);
  const schemaPath = join(repositoryRoot, TASK_SCHEMA_RELATIVE_PATH);

  await mkdir(taskDirectory, { recursive: true });
  await mkdir(join(repositoryRoot, "schemas/v1"), { recursive: true });
  await writeFile(schemaPath, await readFile(sourceSchemaPath, "utf8"), "utf8");

  for (const [name, content] of Object.entries(files)) {
    await writeFile(
      join(taskDirectory, name),
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
      "utf8",
    );
  }

  return { repositoryRoot, taskDirectory, schemaPath };
}

async function withFixtureRepository(files, callback) {
  const fixture = await createFixtureRepository(files);
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true });
  }
}

function expectRegistryError(error, code) {
  assert.ok(error instanceof TaskRegistryLoadError);
  assert.ok(error.diagnostics.some((diagnostic) => diagnostic.code === code));
  return true;
}

test("loads a valid multi-task fixture into stable task-id order", async () => {
  await withFixtureRepository(
    {
      "zeta.task.json": validTask("BOOT-010"),
      "alpha.task.json": validTask("BOOT-006"),
      "README.md": "ignored",
    },
    async ({ repositoryRoot }) => {
      const registry = await loadTaskRegistry({ repositoryRoot });
      assert.deepEqual([...registry.keys()], ["BOOT-006", "BOOT-010"]);
      assert.equal(registry.get("BOOT-006")?.sourcePath, "tasks/definitions/alpha.task.json");
      assert.equal(registry.get("BOOT-010")?.taskId, "BOOT-010");
    },
  );
});

test("rejects duplicate task IDs with deterministic source diagnostics", async () => {
  await withFixtureRepository(
    {
      "a.task.json": validTask("BOOT-006"),
      "b.task.json": validTask("BOOT-006", { title: "Duplicate" }),
    },
    async ({ repositoryRoot }) => {
      await assert.rejects(
        () => loadTaskRegistry({ repositoryRoot }),
        (error) => {
          expectRegistryError(error, "TASK_ID_DUPLICATE");
          assert.match(error.message, /tasks\/definitions\/b\.task\.json/);
          assert.match(error.message, /first loaded from tasks\/definitions\/a\.task\.json/);
          return true;
        },
      );
    },
  );
});

test("rejects malformed JSON and identifies the offending path", async () => {
  await withFixtureRepository(
    { "broken.task.json": "{ nope" },
    async ({ repositoryRoot }) => {
      await assert.rejects(
        () => loadTaskRegistry({ repositoryRoot }),
        (error) => {
          expectRegistryError(error, "TASK_PARSE_ERROR");
          assert.match(error.message, /tasks\/definitions\/broken\.task\.json/);
          return true;
        },
      );
    },
  );
});

test("rejects schema-invalid task with a field-level validation reason", async () => {
  const invalid = validTask("BOOT-006");
  delete invalid.allowedPaths;

  await withFixtureRepository(
    { "invalid.task.json": invalid },
    async ({ repositoryRoot }) => {
      await assert.rejects(
        () => loadTaskRegistry({ repositoryRoot }),
        (error) => {
          expectRegistryError(error, "TASK_SCHEMA_VALIDATION_FAILED");
          assert.match(error.message, /\$\.allowedPaths: required property is missing/);
          return true;
        },
      );
    },
  );
});

test("rejects unknown task schema major version before structural fallback", async () => {
  await withFixtureRepository(
    { "future.task.json": validTask("BOOT-999", { schemaVersion: "2.0.0" }) },
    async ({ repositoryRoot }) => {
      await assert.rejects(
        () => loadTaskRegistry({ repositoryRoot }),
        (error) => {
          expectRegistryError(error, "TASK_SCHEMA_VERSION_UNSUPPORTED");
          assert.match(error.message, /Unsupported task schema major version 2/);
          return true;
        },
      );
    },
  );
});

test("rejects same-major versions unless explicitly supported", async () => {
  await withFixtureRepository(
    { "future-minor.task.json": validTask("BOOT-998", { schemaVersion: "1.1.0" }) },
    async ({ repositoryRoot }) => {
      await assert.rejects(
        () => loadTaskRegistry({ repositoryRoot }),
        (error) => {
          expectRegistryError(error, "TASK_SCHEMA_VERSION_UNSUPPORTED");
          assert.match(error.message, /not explicitly supported/);
          return true;
        },
      );
    },
  );
});

test("normalized registry is identical when file paths are presented in reverse order", async () => {
  await withFixtureRepository(
    {
      "a.task.json": validTask("BOOT-006"),
      "b.task.json": validTask("BOOT-010"),
    },
    async ({ repositoryRoot, taskDirectory, schemaPath }) => {
      const a = join(taskDirectory, "a.task.json");
      const b = join(taskDirectory, "b.task.json");
      const forward = await loadTaskRegistryFromPaths([a, b], { repositoryRoot, schemaPath });
      const reverse = await loadTaskRegistryFromPaths([b, a], { repositoryRoot, schemaPath });

      assert.deepEqual([...forward.entries()], [...reverse.entries()]);
      assert.deepEqual([...forward.keys()], ["BOOT-006", "BOOT-010"]);
    },
  );
});

test("reader declares the exact supported task schema version", () => {
  assert.equal(SUPPORTED_TASK_SCHEMA_VERSION, "1.0.0");
});
