import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BranchLifecycleError,
  GitBranchLifecycleAdapter,
  LocalGitBranchOperations,
} from "../dist/git-branch-lifecycle/index.js";

function git(repo, ...args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "ipt-branch-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "IPT Test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-qm", "seed");
  return repo;
}

const task = {
  taskId: "BOOT-011",
  canonicalBranch: "bootstrap/boot-011-branch-lifecycle",
};

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof BranchLifecycleError && error.code === code,
  );
}

test("creates a missing canonical branch from main and checks it out", () => {
  const repo = fixture();
  try {
    const base = git(repo, "rev-parse", "refs/heads/main");
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    const result = adapter.ensureTaskBranch(task);

    assert.equal(result.created, true);
    assert.equal(git(repo, "branch", "--show-current"), task.canonicalBranch);
    assert.equal(git(repo, "rev-parse", `refs/heads/${task.canonicalBranch}`), base);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("re-running ensure is idempotent", () => {
  const repo = fixture();
  try {
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    adapter.ensureTaskBranch(task);
    const head = git(repo, "rev-parse", "HEAD");
    const result = adapter.ensureTaskBranch(task);

    assert.equal(result.created, false);
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rejects wrong branch identity with an actionable error", () => {
  const repo = fixture();
  try {
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    expectCode(
      () => adapter.ensureTaskBranch(task, { expectedBranch: "bootstrap/wrong" }),
      "WRONG_BRANCH",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rejects canonical branch metadata with leading or trailing whitespace", () => {
  const repo = fixture();
  try {
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    expectCode(
      () => adapter.ensureTaskBranch({ ...task, canonicalBranch: ` ${task.canonicalBranch}` }),
      "INVALID_TASK_BRANCH",
    );
    expectCode(
      () => adapter.ensureTaskBranch({ ...task, canonicalBranch: `${task.canonicalBranch} ` }),
      "INVALID_TASK_BRANCH",
    );
    assert.equal(git(repo, "branch", "--show-current"), "main");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rejects missing and incorrect base refs", () => {
  const repo = fixture();
  try {
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    git(repo, "branch", "-m", "main", "trunk");

    expectCode(() => adapter.ensureTaskBranch(task), "BASE_REF_NOT_FOUND");
    expectCode(
      () => adapter.ensureTaskBranch(task, { baseRef: "trunk" }),
      "BASE_REF_MISMATCH",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("does not treat a same-named tag as the canonical local branch", () => {
  const repo = fixture();
  try {
    git(repo, "tag", task.canonicalBranch);
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    const result = adapter.ensureTaskBranch(task);

    assert.equal(result.created, true);
    assert.equal(git(repo, "branch", "--show-current"), task.canonicalBranch);
    assert.equal(
      git(repo, "rev-parse", `refs/heads/${task.canonicalBranch}`),
      git(repo, "rev-parse", "refs/heads/main"),
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("does not treat a same-named tag as the required main base branch", () => {
  const repo = fixture();
  try {
    git(repo, "tag", "main");
    git(repo, "branch", "-m", "main", "trunk");
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));

    expectCode(() => adapter.ensureTaskBranch(task), "BASE_REF_NOT_FOUND");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rejects unrelated current branch instead of silently switching", () => {
  const repo = fixture();
  try {
    const adapter = new GitBranchLifecycleAdapter(new LocalGitBranchOperations(repo));
    adapter.ensureTaskBranch(task);
    git(repo, "checkout", "-qb", "unrelated", "main");

    expectCode(() => adapter.ensureTaskBranch(task), "WRONG_BRANCH");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
