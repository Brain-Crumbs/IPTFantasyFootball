import assert from "node:assert/strict";
import test from "node:test";
import { ContextCompilationError, compileRoleContext } from "../dist/context-compiler/index.js";

const revision = "abc123";

const dependency = Object.freeze({
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
  dependencies: [dependency.taskId],
  canonicalBranch: "bootstrap/boot-012-context-compiler",
  allowedPaths: ["src/context-compiler/**"],
  requirements: ["BOOT-012-R1"],
  acceptanceCriteria: ["role isolation", "determinism"],
  validationPlan: ["compile all roles"],
  affectedContracts: ["control-plane.context-compiler"],
  requiredReviewRoles: ["Developer", "QA", "Architect", "UAT/Product", "MergeController"],
  sourcePath: "tasks/definitions/boot-012.task.json",
});

const currentContract = {
  artifactId: "contract:context",
  kind: "contract",
  sourcePath: "contracts/context-compiler/module-contract.json",
  referenceId: "control-plane.context-compiler",
  content: {
    knownConsumers: [
      {
        consumerId: "control-plane.dev-start",
        expectations: ["current"],
        requiredCapabilities: ["developer-context"],
        acceptedRanges: ["role-scoped packages"],
        requiredReachableRanges: ["Developer package"],
      },
    ],
  },
};

const baseArtifacts = Object.freeze([
  {
    artifactId: "requirement:r1",
    kind: "requirement",
    sourcePath: "requirements/boot-012-r1.json",
    referenceId: "BOOT-012-R1",
    content: { text: "role-aware context" },
  },
  currentContract,
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
]);

const registry = new Map([
  [dependency.taskId, dependency],
  [task.taskId, task],
]);

function expectCompilationError(fn, code, reference) {
  assert.throws(
    fn,
    (error) =>
      error instanceof ContextCompilationError &&
      error.code === code &&
      error.reference === reference,
  );
}

test("stale required requirement and contract artifacts do not satisfy required references", () => {
  const staleRequirement = baseArtifacts.map((artifact) =>
    artifact.artifactId === "requirement:r1"
      ? { ...artifact, revision: "old-revision" }
      : artifact,
  );
  expectCompilationError(
    () => compileRoleContext({ role: "Developer", task, registry, revision, artifacts: staleRequirement }),
    "REQUIREMENT_ARTIFACT_MISSING",
    "BOOT-012-R1",
  );

  const staleContract = baseArtifacts.map((artifact) =>
    artifact.artifactId === "contract:context"
      ? { ...artifact, revision: "old-revision" }
      : artifact,
  );
  expectCompilationError(
    () => compileRoleContext({ role: "Developer", task, registry, revision, artifacts: staleContract }),
    "CONTRACT_ARTIFACT_MISSING",
    "control-plane.context-compiler",
  );
});

test("Architect derives consumer semantics only from revision-eligible contracts", () => {
  const staleContract = {
    ...currentContract,
    artifactId: "contract:context:old",
    sourcePath: "contracts/context-compiler/old-module-contract.json",
    revision: "old-revision",
    content: {
      knownConsumers: [
        {
          consumerId: "control-plane.dev-start",
          expectations: ["stale"],
          requiredCapabilities: ["old"],
          acceptedRanges: ["old"],
          requiredReachableRanges: ["old"],
        },
      ],
    },
  };
  const revisionBoundCurrentContract = { ...currentContract, revision };
  const artifacts = [
    ...baseArtifacts.filter((artifact) => artifact.artifactId !== "contract:context"),
    staleContract,
    revisionBoundCurrentContract,
  ];

  const pkg = compileRoleContext({ role: "Architect", task, registry, revision, artifacts });
  const consumers = pkg.artifacts.filter(
    (artifact) =>
      artifact.artifactId ===
      "consumer-requirement:control-plane.context-compiler:control-plane.dev-start",
  );

  assert.equal(consumers.length, 1);
  assert.deepEqual(consumers[0].content.expectations, ["current"]);
  assert.ok(
    pkg.manifest.excluded.some(
      (entry) => entry.artifactId === "contract:context:old" && entry.reason === "REVISION_MISMATCH",
    ),
  );
});
