import { execFileSync } from "node:child_process";

export interface TaskBranchMetadata {
  readonly taskId: string;
  readonly canonicalBranch: string;
}

export interface EnsureTaskBranchOptions {
  readonly expectedBranch?: string;
  readonly baseRef?: string;
}

export interface BranchEnsureResult {
  readonly taskId: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly created: boolean;
}

export type BranchLifecycleErrorCode =
  | "INVALID_TASK_BRANCH"
  | "WRONG_BRANCH"
  | "BASE_REF_MISMATCH"
  | "BASE_REF_NOT_FOUND"
  | "BRANCH_DIVERGED"
  | "GIT_COMMAND_FAILED";

export class BranchLifecycleError extends Error {
  readonly code: BranchLifecycleErrorCode;

  constructor(code: BranchLifecycleErrorCode, message: string) {
    super(message);
    this.name = "BranchLifecycleError";
    this.code = code;
  }
}

export interface GitBranchOperations {
  currentBranch(): string;
  refExists(ref: string): boolean;
  isAncestor(ancestorRef: string, descendantRef: string): boolean;
  createBranch(branch: string, baseRef: string): void;
  checkoutBranch(branch: string): void;
}

export class LocalGitBranchOperations implements GitBranchOperations {
  constructor(private readonly repoRoot: string) {}

  currentBranch(): string {
    return this.git(["branch", "--show-current"]).trim();
  }

  refExists(ref: string): boolean {
    try {
      this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  isAncestor(ancestorRef: string, descendantRef: string): boolean {
    try {
      this.git(["merge-base", "--is-ancestor", ancestorRef, descendantRef]);
      return true;
    } catch {
      return false;
    }
  }

  createBranch(branch: string, baseRef: string): void {
    this.git(["branch", branch, baseRef]);
  }

  checkoutBranch(branch: string): void {
    this.git(["checkout", "--quiet", branch]);
  }

  private git(args: readonly string[]): string {
    try {
      return execFileSync("git", args, {
        cwd: this.repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BranchLifecycleError(
        "GIT_COMMAND_FAILED",
        `Git command failed in ${this.repoRoot}: git ${args.join(" ")}. ${detail}`,
      );
    }
  }
}

export class GitBranchLifecycleAdapter {
  constructor(
    private readonly git: GitBranchOperations,
    private readonly integrationTarget = "main",
  ) {}

  canonicalBranch(task: TaskBranchMetadata): string {
    const branch = task.canonicalBranch.trim();
    if (branch.length === 0) {
      throw new BranchLifecycleError(
        "INVALID_TASK_BRANCH",
        `Task ${task.taskId} does not declare a non-empty canonicalBranch.`,
      );
    }
    return branch;
  }

  assertCurrentTaskBranch(task: TaskBranchMetadata): void {
    const expected = this.canonicalBranch(task);
    const actual = this.git.currentBranch();
    if (actual !== expected) {
      throw new BranchLifecycleError(
        "WRONG_BRANCH",
        `Task ${task.taskId} must run on canonical branch '${expected}', but the repository is on '${actual || "detached HEAD"}'. Checkout '${expected}' before continuing.`,
      );
    }
  }

  ensureTaskBranch(
    task: TaskBranchMetadata,
    options: EnsureTaskBranchOptions = {},
  ): BranchEnsureResult {
    const canonical = this.canonicalBranch(task);
    if (options.expectedBranch !== undefined && options.expectedBranch !== canonical) {
      throw new BranchLifecycleError(
        "WRONG_BRANCH",
        `Task ${task.taskId} declares canonical branch '${canonical}', not '${options.expectedBranch}'.`,
      );
    }

    const baseRef = options.baseRef ?? this.integrationTarget;
    if (baseRef !== this.integrationTarget) {
      throw new BranchLifecycleError(
        "BASE_REF_MISMATCH",
        `Task ${task.taskId} must use bootstrap integration target '${this.integrationTarget}' as its base, not '${baseRef}'.`,
      );
    }
    if (!this.git.refExists(baseRef)) {
      throw new BranchLifecycleError(
        "BASE_REF_NOT_FOUND",
        `Required base ref '${baseRef}' does not exist. Fetch or restore '${baseRef}' before creating '${canonical}'.`,
      );
    }

    const branchExists = this.git.refExists(canonical);
    if (!branchExists) {
      const current = this.git.currentBranch();
      if (current !== baseRef) {
        throw new BranchLifecycleError(
          "WRONG_BRANCH",
          `Cannot create '${canonical}' for ${task.taskId} while on '${current || "detached HEAD"}'. Checkout base '${baseRef}' first.`,
        );
      }
      this.git.createBranch(canonical, baseRef);
      this.git.checkoutBranch(canonical);
      return { taskId: task.taskId, branch: canonical, baseRef, created: true };
    }

    if (!this.git.isAncestor(baseRef, canonical)) {
      throw new BranchLifecycleError(
        "BRANCH_DIVERGED",
        `Canonical branch '${canonical}' is not based on required ref '${baseRef}'. Do not force-move it; inspect and recover the branch explicitly.`,
      );
    }

    const current = this.git.currentBranch();
    if (current === baseRef) {
      this.git.checkoutBranch(canonical);
    } else if (current !== canonical) {
      throw new BranchLifecycleError(
        "WRONG_BRANCH",
        `Task ${task.taskId} uses '${canonical}', but repository is on unrelated branch '${current || "detached HEAD"}'. Checkout '${canonical}' explicitly.`,
      );
    }

    return { taskId: task.taskId, branch: canonical, baseRef, created: false };
  }
}
