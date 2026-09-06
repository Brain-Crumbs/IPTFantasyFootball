import assert from "node:assert/strict";
import test from "node:test";
import { ContextCompilationError, compileRoleContext } from "../dist/context-compiler/index.js";

const revision = "abc123";

const dep = Object.freeze({
  schemaId: "ipt.task",
  schemaVersion: "1.0.0",
  taskId: "BOOT-010",
  title: "Dependency",
  objective: "Dependency objective",
  inScope: [],
  outOfScope: [],
  dependencies: [],
  canonicalBranch: "bootstrap/boot-010-dep",
  allowedPaths: ["src/dep/**"],
  requirements: [],
  acceptanceCriteria: ["dep works"],
  validationPlan: ["test dep"],
  affectedContracts: ["control-plane.dep"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-010.task.json",
});

const task = Object.freeze({
  schemaId: "ipt.task",
  schemaVersion: "1.0.0",
  taskId: "BOOT-012",
  title: "Context compiler",
  objective: "Compile role-specific context",
  inScope: ["compile roles"],
  outOfScope: ["invoke agents"],
  dependencies: [dep.taskId],
  canonicalBranch: "bootstrap/boot-012-context-compiler",
  allowedPaths: ["src/context-compiler/**"],
  requirements: ["BOOT-012-R1"],
  acceptanceCriteria: ["role isolation", "determinism"],
  validationPlan: ["compile all roles"],
  affectedContracts: ["control-plane.context-compiler"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-012.task.json",
});

const primaryContract = {
  artifactId: "contract:context",
  kind: "contract",
  sourcePath: "contracts/context-compiler/module-contract.json",
  referenceId: "control-plane.context-compiler",
  content: {
    knownConsumers: [
      {
        consumerId: "control-plane.dev-start",
        expectations: ["developer context remains local"],
        requiredCapabilities: ["developer-context"],
        acceptedRanges: ["role-scoped packages"],
        requiredReachableRanges: ["Developer package"],
      },
    ],
  },
};

const artifacts = Object.freeze([
  {
    artifactId: "requirement:r1",
    kind: "requirement",
    sourcePath: "requirements/boot-012-r1.json",
    referenceId: "BOOT-012-R1",
    content: { text: "role-aware context" },
  },
  primaryContract,
  {
    artifactId: "contract:dep",
    kind: "contract",
    sourcePath: "contracts/dep/module-contract.json",
    referenceId: "control-plane.dep",
    content: { knownConsumers: [] },
  },
  {
    artifactId: "diff:current",
    kind: "diff",
    sourcePath: "git/diff/abc123.patch",
    taskIds: [task.taskId],
    revision,
    content: "diff",
  },
  {
    artifactId: "evidence:dev-validation",
    kind: "evidence",
    sourcePath: "evidence/dev.json",
    taskIds: [task.taskId],
    revision,
    evidenceRole: "Developer",
    authority: "authoritative",
    content: { passed: true },
  },
  {
    artifactId: "evidence:developer-story",
    kind: "evidence",
    sourcePath: "evidence/dev-story.md",
    taskIds: [task.taskId],
    revision,
    evidenceRole: "Developer",
    authority: "developer-narrative",
    content: "I think it is correct",
  },
  {
    artifactId: "evidence:qa",
    kind: "evidence",
    sourcePath: "evidence/qa.json",
    taskIds: [task.taskId],
    revision,
    evidenceRole: "QA",
    authority: "authoritative",
    content: { outcome: "PASS" },
  },
  {
    artifactId: "evidence:architect",
    kind: "evidence",
    sourcePath: "evidence/architect.json",
    taskIds: [task.taskId],
    revision,
    evidenceRole: "Architect",
    authority: "authoritative",
    content: { outcome: "PASS" },
  },
  {
    artifactId: "fixture:local",
    kind: "fixture",
    sourcePath: "tests/fixtures/context.json",
    taskIds: [task.taskId],
    content: { fixture: true },
  },
  {
    artifactId: "scenario:uat",
    kind: "scenario",
    sourcePath: "tests/scenarios/context.md",
    taskIds: [task.taskId],
    content: "realistic outcome",
  },
  {
    artifactId: "policy:architecture",
    kind: "policy",
    sourcePath: "CONSTITUTION.md",
    content: "architecture invariant",
  },
  {
    artifactId: "unrelated",
    kind: "scenario",
    sourcePath: "other.md",
    taskIds: ["BOOT-999"],
    content: "unrelated",
  },
]);

const registry = new Map([
  [dep.taskId, dep],
  [task.taskId, task],
]);

function ids(pkg) {
  return pkg.artifacts.map((artifact) => artifact.artifactId);
}

test("compiles role-specific inclusion/exclusion matrix", () => {
  const developer = compileRoleContext({ role: "Developer", task, registry, revision, artifacts });
  const qa = compileRoleContext({ role: "QA", task, registry, revision, artifacts });
  const architect = compileRoleContext({ role: "Architect", task, registry, revision, artifacts });
  const uat = compileRoleContext({ role: "UAT/Product", task, registry, revision, artifacts });
  const merge = compileRoleContext({ role: "MergeController", task, registry, revision, artifacts });

  assert.deepEqual(ids(developer), [
    "contract:context",
    "contract:dep",
    "dependency-task:BOOT-010",
    "fixture:local",
    "requirement:r1",
    "scenario:uat",
    "task:BOOT-012",
  ]);
  assert.ok(ids(qa).includes("diff:current"));
  assert.ok(ids(qa).includes("evidence:dev-validation"));
  assert.ok(!ids(qa).includes("evidence:developer-story"));
  assert.ok(!ids(qa).includes("contract:dep"));

  assert.ok(
    ids(architect).includes(
      "consumer-requirement:control-plane.context-compiler:control-plane.dev-start",
    ),
  );
  assert.ok(ids(architect).includes("contract:dep"));
  assert.ok(ids(architect).includes("policy:architecture"));
  assert.ok(!ids(developer).some((id) => id.startsWith("consumer-requirement:")));
  assert.equal(
    Object.hasOwn(
      developer.artifacts.find((artifact) => artifact.artifactId === "contract:context").content,
      "knownConsumers",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      qa.artifacts.find((artifact) => artifact.artifactId === "contract:context").content,
      "knownConsumers",
    ),
    false,
  );

  assert.deepEqual(Object.keys(uat.task), ["taskId", "title", "objective", "acceptanceCriteria"]);
  assert.ok(ids(uat).includes("scenario:uat"));
  assert.ok(ids(uat).includes("evidence:qa"));
  assert.ok(ids(uat).includes("evidence:architect"));
  assert.ok(!ids(uat).includes("diff:current"));
  assert.ok(!ids(uat).includes("contract:context"));

  assert.deepEqual(Object.keys(merge.task), [
    "taskId",
    "title",
    "canonicalBranch",
    "requiredReviewRoles",
  ]);
  assert.ok(ids(merge).includes("policy:architecture"));
  assert.ok(ids(merge).includes("evidence:qa"));
  assert.ok(!ids(merge).includes("diff:current"));
  assert.ok(!ids(merge).includes("contract:context"));
});

test("architect receives consumer semantics omitted from developer context", () => {
  const developer = compileRoleContext({ role: "Developer", task, registry, revision, artifacts });
  const architect = compileRoleContext({ role: "Architect", task, registry, revision, artifacts });

  assert.equal(ids(developer).some((id) => id.startsWith("consumer-requirement:")), false);
  assert.equal(
    Object.hasOwn(
      developer.artifacts.find((artifact) => artifact.artifactId === "contract:context").content,
      "knownConsumers",
    ),
    false,
  );
  const consumer = architect.artifacts.find((artifact) => artifact.kind === "consumer-requirement");
  assert.equal(consumer.content.consumerId, "control-plane.dev-start");
  assert.deepEqual(consumer.content.requiredReachableRanges, ["Developer package"]);
});

test("equivalent recompilation is deterministic regardless of source artifact order", () => {
  const first = compileRoleContext({ role: "Architect", task, registry, revision, artifacts });
  const second = compileRoleContext({
    role: "Architect",
    task,
    registry,
    revision,
    artifacts: [...artifacts].reverse(),
  });
  assert.deepEqual(second, first);
});

test("package records source revision and every included artifact", () => {
  const pkg = compileRoleContext({ role: "QA", task, registry, revision, artifacts });
  assert.equal(pkg.sourceRevision, revision);
  assert.deepEqual(
    pkg.manifest.included,
    pkg.artifacts.map(({ artifactId, kind, sourcePath }) => ({ artifactId, kind, sourcePath })),
  );
  assert.ok(
    pkg.manifest.excluded.some(
      (entry) =>
        entry.artifactId === "evidence:developer-story" &&
        entry.reason === "DEVELOPER_NARRATIVE_NOT_AUTHORITY",
    ),
  );
});

test("missing required artifact fails explicitly", () => {
  const withoutContract = artifacts.filter((artifact) => artifact.artifactId !== "contract:context");
  assert.throws(
    () =>
      compileRoleContext({ role: "Developer", task, registry, revision, artifacts: withoutContract }),
    (error) =>
      error instanceof ContextCompilationError &&
      error.code === "CONTRACT_ARTIFACT_MISSING" &&
      error.reference === "control-plane.context-compiler",
  );
});

test("QA and Architect require an exact-revision diff", () => {
  const wrongRevision = artifacts.map((artifact) =>
    artifact.kind === "diff" ? { ...artifact, revision: "old-revision" } : artifact,
  );
  for (const role of ["QA", "Architect"]) {
    assert.throws(
      () => compileRoleContext({ role, task, registry, revision, artifacts: wrongRevision }),
      (error) => error instanceof ContextCompilationError && error.code === "DIFF_ARTIFACT_MISSING",
    );
  }
});
