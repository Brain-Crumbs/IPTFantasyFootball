import type { RegisteredTask, TaskRegistry } from "../task-registry/index.js";

export const CONTEXT_PACKAGE_SCHEMA_VERSION = "1.0.0" as const;

export type ContextRole = "Developer" | "QA" | "Architect" | "UAT/Product" | "MergeController";
export type ContextSourceArtifactKind =
  | "requirement"
  | "contract"
  | "consumer-requirement"
  | "evidence"
  | "diff"
  | "fixture"
  | "scenario"
  | "policy";
export type ContextPackageArtifactKind = ContextSourceArtifactKind | "task" | "dependency-task";

export type ContextEvidenceAuthority = "authoritative" | "developer-narrative";

export interface ContextArtifact {
  artifactId: string;
  kind: ContextSourceArtifactKind;
  sourcePath: string;
  content: unknown;
  referenceId?: string;
  taskIds?: readonly string[];
  contractIds?: readonly string[];
  revision?: string;
  evidenceRole?: ContextRole;
  authority?: ContextEvidenceAuthority;
}

export interface ContextCompileInput {
  role: ContextRole;
  task: RegisteredTask;
  registry: TaskRegistry;
  revision: string;
  artifacts: readonly ContextArtifact[];
}

export type ContextManifestExclusionReason =
  | "ROLE_POLICY"
  | "UNRELATED"
  | "REVISION_MISMATCH"
  | "DEVELOPER_NARRATIVE_NOT_AUTHORITY";

export interface ContextManifestEntry {
  artifactId: string;
  kind: ContextPackageArtifactKind;
  sourcePath: string;
}

export interface ContextManifestExcludedEntry {
  artifactId: string;
  kind: ContextSourceArtifactKind;
  sourcePath: string;
  reason: ContextManifestExclusionReason;
}

export interface CompiledContextArtifact extends ContextManifestEntry {
  content: unknown;
}

export interface ContextPackage {
  schemaVersion: typeof CONTEXT_PACKAGE_SCHEMA_VERSION;
  role: ContextRole;
  taskId: string;
  sourceRevision: string;
  task: Readonly<Record<string, unknown>>;
  artifacts: readonly CompiledContextArtifact[];
  manifest: Readonly<{
    included: readonly ContextManifestEntry[];
    excluded: readonly ContextManifestExcludedEntry[];
  }>;
}

export type ContextCompilationErrorCode =
  | "INVALID_REVISION"
  | "DUPLICATE_ARTIFACT_ID"
  | "DEPENDENCY_TASK_MISSING"
  | "REQUIREMENT_ARTIFACT_MISSING"
  | "CONTRACT_ARTIFACT_MISSING"
  | "DIFF_ARTIFACT_MISSING";

export class ContextCompilationError extends Error {
  readonly code: ContextCompilationErrorCode;
  readonly reference: string;

  constructor(code: ContextCompilationErrorCode, reference: string, message: string) {
    super(message);
    this.name = "ContextCompilationError";
    this.code = code;
    this.reference = reference;
  }
}

interface CandidateArtifact {
  artifactId: string;
  kind: ContextPackageArtifactKind;
  sourcePath: string;
  content: unknown;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function taskView(task: RegisteredTask, role: ContextRole): Readonly<Record<string, unknown>> {
  const common = { taskId: task.taskId, title: task.title };
  switch (role) {
    case "Developer":
      return Object.freeze({
        ...common,
        objective: task.objective,
        inScope: freezeStrings(task.inScope),
        outOfScope: freezeStrings(task.outOfScope),
        dependencies: freezeStrings(task.dependencies),
        canonicalBranch: task.canonicalBranch,
        allowedPaths: freezeStrings(task.allowedPaths),
        requirements: freezeStrings(task.requirements),
        acceptanceCriteria: freezeStrings(task.acceptanceCriteria),
        validationPlan: freezeStrings(task.validationPlan),
        affectedContracts: freezeStrings(task.affectedContracts),
      });
    case "QA":
      return Object.freeze({
        ...common,
        requirements: freezeStrings(task.requirements),
        acceptanceCriteria: freezeStrings(task.acceptanceCriteria),
        validationPlan: freezeStrings(task.validationPlan),
        affectedContracts: freezeStrings(task.affectedContracts),
      });
    case "Architect":
      return Object.freeze({
        ...common,
        objective: task.objective,
        dependencies: freezeStrings(task.dependencies),
        requirements: freezeStrings(task.requirements),
        acceptanceCriteria: freezeStrings(task.acceptanceCriteria),
        affectedContracts: freezeStrings(task.affectedContracts),
      });
    case "UAT/Product":
      return Object.freeze({
        ...common,
        objective: task.objective,
        acceptanceCriteria: freezeStrings(task.acceptanceCriteria),
      });
    case "MergeController":
      return Object.freeze({
        ...common,
        canonicalBranch: task.canonicalBranch,
        requiredReviewRoles: freezeStrings(task.requiredReviewRoles),
      });
  }
}

function taskArtifact(
  task: RegisteredTask,
  role: ContextRole,
  kind: "task" | "dependency-task",
): CandidateArtifact {
  return {
    artifactId: `${kind}:${task.taskId}`,
    kind,
    sourcePath: task.sourcePath,
    content: taskView(task, role),
  };
}

function relationIncludes(values: readonly string[] | undefined, value: string): boolean {
  return values?.includes(value) ?? false;
}

function candidateSort(left: CandidateArtifact, right: CandidateArtifact): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.artifactId, right.artifactId) ||
    compareText(left.sourcePath, right.sourcePath)
  );
}

function sourceArtifactSort(left: ContextArtifact, right: ContextArtifact): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.artifactId, right.artifactId) ||
    compareText(left.sourcePath, right.sourcePath)
  );
}

function ensureUniqueArtifactIds(artifacts: readonly ContextArtifact[]): void {
  const seen = new Set<string>();
  for (const artifact of [...artifacts].sort(sourceArtifactSort)) {
    if (seen.has(artifact.artifactId)) {
      throw new ContextCompilationError(
        "DUPLICATE_ARTIFACT_ID",
        artifact.artifactId,
        `Context artifact '${artifact.artifactId}' is duplicated`,
      );
    }
    seen.add(artifact.artifactId);
  }
}

function findReference(
  artifacts: readonly ContextArtifact[],
  kind: ContextSourceArtifactKind,
  referenceId: string,
): ContextArtifact | undefined {
  return [...artifacts]
    .sort(sourceArtifactSort)
    .find((artifact) => artifact.kind === kind && artifact.referenceId === referenceId);
}

function dependencyTasksForRole(input: ContextCompileInput): readonly RegisteredTask[] {
  if (input.role !== "Developer" && input.role !== "Architect") {
    return Object.freeze([]);
  }
  return Object.freeze(
    [...input.task.dependencies]
      .sort(compareText)
      .map((taskId) => {
        const dependency = input.registry.get(taskId);
        if (dependency === undefined) {
          throw new ContextCompilationError(
            "DEPENDENCY_TASK_MISSING",
            taskId,
            `Dependency task '${taskId}' referenced by ${input.task.taskId} is missing from the registry`,
          );
        }
        return dependency;
      }),
  );
}

function requireReferencedArtifacts(input: ContextCompileInput, dependencyTasks: readonly RegisteredTask[]): void {
  if (input.role === "Developer" || input.role === "QA" || input.role === "Architect") {
    for (const requirementId of [...input.task.requirements].sort(compareText)) {
      if (findReference(input.artifacts, "requirement", requirementId) === undefined) {
        throw new ContextCompilationError(
          "REQUIREMENT_ARTIFACT_MISSING",
          requirementId,
          `Required requirement artifact '${requirementId}' is missing for ${input.task.taskId}`,
        );
      }
    }

    const contractIds = new Set(input.task.affectedContracts);
    if (input.role === "Developer" || input.role === "Architect") {
      for (const dependency of dependencyTasks) {
        for (const contractId of dependency.affectedContracts) {
          contractIds.add(contractId);
        }
      }
    }
    for (const contractId of [...contractIds].sort(compareText)) {
      if (findReference(input.artifacts, "contract", contractId) === undefined) {
        throw new ContextCompilationError(
          "CONTRACT_ARTIFACT_MISSING",
          contractId,
          `Required contract artifact '${contractId}' is missing for ${input.task.taskId}`,
        );
      }
    }
  }

  if (input.role === "QA" || input.role === "Architect") {
    const diff = input.artifacts.find(
      (artifact) =>
        artifact.kind === "diff" &&
        artifact.revision === input.revision &&
        relationIncludes(artifact.taskIds, input.task.taskId),
    );
    if (diff === undefined) {
      throw new ContextCompilationError(
        "DIFF_ARTIFACT_MISSING",
        input.revision,
        `Exact-revision diff artifact is missing for ${input.task.taskId}@${input.revision}`,
      );
    }
  }
}

function relatedToTask(artifact: ContextArtifact, taskId: string): boolean {
  return relationIncludes(artifact.taskIds, taskId);
}

function relatedToContracts(artifact: ContextArtifact, contractIds: ReadonlySet<string>): boolean {
  return artifact.contractIds?.some((contractId) => contractIds.has(contractId)) ?? false;
}

function revisionMatches(artifact: ContextArtifact, revision: string): boolean {
  if (artifact.kind === "diff" || artifact.kind === "evidence") {
    return artifact.revision === revision;
  }
  return artifact.revision === undefined || artifact.revision === revision;
}

function includeExternalArtifact(
  artifact: ContextArtifact,
  input: ContextCompileInput,
  dependencyTasks: readonly RegisteredTask[],
): { include: boolean; reason: ContextManifestExclusionReason } {
  const taskContractIds = new Set(input.task.affectedContracts);
  const dependencyContractIds = new Set(dependencyTasks.flatMap((task) => [...task.affectedContracts]));
  const local = relatedToTask(artifact, input.task.taskId);
  const taskContract = artifact.referenceId !== undefined && taskContractIds.has(artifact.referenceId);
  const dependencyContract = artifact.referenceId !== undefined && dependencyContractIds.has(artifact.referenceId);
  const consumerRequirement =
    artifact.kind === "consumer-requirement" && relatedToContracts(artifact, taskContractIds);

  if (!revisionMatches(artifact, input.revision)) {
    return { include: false, reason: "REVISION_MISMATCH" };
  }
  if (input.role !== "Developer" && artifact.authority === "developer-narrative") {
    return { include: false, reason: "DEVELOPER_NARRATIVE_NOT_AUTHORITY" };
  }

  switch (input.role) {
    case "Developer":
      if (artifact.kind === "requirement" && input.task.requirements.includes(artifact.referenceId ?? "")) {
        return { include: true, reason: "UNRELATED" };
      }
      if (artifact.kind === "contract" && (taskContract || dependencyContract)) {
        return { include: true, reason: "UNRELATED" };
      }
      if ((artifact.kind === "fixture" || artifact.kind === "scenario") && local) {
        return { include: true, reason: "UNRELATED" };
      }
      return {
        include: false,
        reason:
          artifact.kind === "evidence" || artifact.kind === "diff" || artifact.kind === "policy"
            ? "ROLE_POLICY"
            : "UNRELATED",
      };

    case "QA":
      if (artifact.kind === "requirement" && input.task.requirements.includes(artifact.referenceId ?? "")) {
        return { include: true, reason: "UNRELATED" };
      }
      if (artifact.kind === "contract" && taskContract) {
        return { include: true, reason: "UNRELATED" };
      }
      if (
        (artifact.kind === "fixture" ||
          artifact.kind === "scenario" ||
          artifact.kind === "diff" ||
          artifact.kind === "evidence") &&
        local
      ) {
        return { include: true, reason: "UNRELATED" };
      }
      return { include: false, reason: artifact.kind === "policy" ? "ROLE_POLICY" : "UNRELATED" };

    case "Architect":
      if (artifact.kind === "requirement" && input.task.requirements.includes(artifact.referenceId ?? "")) {
        return { include: true, reason: "UNRELATED" };
      }
      if (artifact.kind === "contract" && (taskContract || dependencyContract)) {
        return { include: true, reason: "UNRELATED" };
      }
      if ((artifact.kind === "diff" || artifact.kind === "evidence") && local) {
        return { include: true, reason: "UNRELATED" };
      }
      if (artifact.kind === "policy") {
        return { include: true, reason: "UNRELATED" };
      }
      if (artifact.kind === "scenario" && local) {
        return { include: true, reason: "UNRELATED" };
      }
      if (consumerRequirement) {
        return { include: true, reason: "UNRELATED" };
      }
      return { include: false, reason: artifact.kind === "fixture" ? "ROLE_POLICY" : "UNRELATED" };

    case "UAT/Product":
      if (artifact.kind === "scenario" && local) {
        return { include: true, reason: "UNRELATED" };
      }
      if (
        artifact.kind === "evidence" &&
        local &&
        (artifact.evidenceRole === "QA" || artifact.evidenceRole === "Architect")
      ) {
        return { include: true, reason: "UNRELATED" };
      }
      return { include: false, reason: "ROLE_POLICY" };

    case "MergeController":
      if (artifact.kind === "policy") {
        return { include: true, reason: "UNRELATED" };
      }
      if (artifact.kind === "evidence" && local) {
        return { include: true, reason: "UNRELATED" };
      }
      return { include: false, reason: "ROLE_POLICY" };
  }
}

function contentForRole(artifact: ContextArtifact, role: ContextRole): unknown {
  if (artifact.kind !== "contract" || role === "Architect") {
    return artifact.content;
  }
  if (typeof artifact.content !== "object" || artifact.content === null || Array.isArray(artifact.content)) {
    return artifact.content;
  }

  const record = artifact.content as Record<string, unknown>;
  const redactedEntries = Object.keys(record)
    .filter((key) => key !== "knownConsumers")
    .sort(compareText)
    .map((key) => [key, record[key]] as const);
  return Object.freeze(Object.fromEntries(redactedEntries));
}

function toCandidate(artifact: ContextArtifact, role: ContextRole): CandidateArtifact {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    sourcePath: artifact.sourcePath,
    content: contentForRole(artifact, role),
  };
}

function derivedConsumerArtifacts(contracts: readonly ContextArtifact[]): readonly CandidateArtifact[] {
  const derived: CandidateArtifact[] = [];
  for (const contract of contracts) {
    if (contract.kind !== "contract" || contract.referenceId === undefined) continue;
    const content = contract.content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) continue;
    const knownConsumers = (content as Record<string, unknown>).knownConsumers;
    if (!Array.isArray(knownConsumers)) continue;

    for (const consumer of knownConsumers) {
      if (typeof consumer !== "object" || consumer === null || Array.isArray(consumer)) continue;
      const record = consumer as Record<string, unknown>;
      const consumerId = record.consumerId;
      if (typeof consumerId !== "string" || consumerId.length === 0) continue;
      derived.push({
        artifactId: `consumer-requirement:${contract.referenceId}:${consumerId}`,
        kind: "consumer-requirement",
        sourcePath: `${contract.sourcePath}#knownConsumers/${consumerId}`,
        content: Object.freeze({
          contractId: contract.referenceId,
          consumerId,
          expectations: record.expectations ?? [],
          requiredCapabilities: record.requiredCapabilities ?? [],
          acceptedRanges: record.acceptedRanges ?? [],
          requiredReachableRanges: record.requiredReachableRanges ?? [],
        }),
      });
    }
  }
  return Object.freeze(derived.sort(candidateSort));
}

function ensureIncludedIdsAreUnique(artifacts: readonly CandidateArtifact[]): void {
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.artifactId)) {
      throw new ContextCompilationError(
        "DUPLICATE_ARTIFACT_ID",
        artifact.artifactId,
        `Compiled context artifact '${artifact.artifactId}' collides with another included artifact`,
      );
    }
    seen.add(artifact.artifactId);
  }
}

export function compileRoleContext(input: ContextCompileInput): ContextPackage {
  if (input.revision.trim().length === 0 || input.revision !== input.revision.trim()) {
    throw new ContextCompilationError(
      "INVALID_REVISION",
      input.revision,
      "source revision must be non-empty and trimmed",
    );
  }

  ensureUniqueArtifactIds(input.artifacts);
  const dependencyTasks = dependencyTasksForRole(input);
  requireReferencedArtifacts(input, dependencyTasks);

  const included: CandidateArtifact[] = [taskArtifact(input.task, input.role, "task")];
  if (input.role === "Developer" || input.role === "Architect") {
    for (const dependency of dependencyTasks) {
      included.push(taskArtifact(dependency, input.role, "dependency-task"));
    }
  }

  if (input.role === "Architect") {
    included.push(
      ...derivedConsumerArtifacts(
        input.artifacts.filter(
          (artifact) =>
            artifact.kind === "contract" &&
            artifact.referenceId !== undefined &&
            input.task.affectedContracts.includes(artifact.referenceId),
        ),
      ),
    );
  }

  const excluded: ContextManifestExcludedEntry[] = [];
  for (const artifact of [...input.artifacts].sort(sourceArtifactSort)) {
    const decision = includeExternalArtifact(artifact, input, dependencyTasks);
    if (decision.include) {
      included.push(toCandidate(artifact, input.role));
    } else {
      excluded.push(
        Object.freeze({
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          sourcePath: artifact.sourcePath,
          reason: decision.reason,
        }),
      );
    }
  }

  const orderedIncluded = [...included].sort(candidateSort);
  ensureIncludedIdsAreUnique(orderedIncluded);

  const artifacts = Object.freeze(
    orderedIncluded.map((artifact) =>
      Object.freeze({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        sourcePath: artifact.sourcePath,
        content: artifact.content,
      }),
    ),
  );
  const includedManifest = Object.freeze(
    orderedIncluded.map((artifact) =>
      Object.freeze({ artifactId: artifact.artifactId, kind: artifact.kind, sourcePath: artifact.sourcePath }),
    ),
  );
  const excludedManifest = Object.freeze(
    [...excluded].sort(
      (left, right) =>
        compareText(left.kind, right.kind) ||
        compareText(left.artifactId, right.artifactId) ||
        compareText(left.sourcePath, right.sourcePath),
    ),
  );

  return Object.freeze({
    schemaVersion: CONTEXT_PACKAGE_SCHEMA_VERSION,
    role: input.role,
    taskId: input.task.taskId,
    sourceRevision: input.revision,
    task: taskView(input.task, input.role),
    artifacts,
    manifest: Object.freeze({ included: includedManifest, excluded: excludedManifest }),
  });
}
