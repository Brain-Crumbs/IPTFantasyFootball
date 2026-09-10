# Continuous Integration

**Task:** BOOT-023 / issue #25
**Parent architecture:** issue #1
**Workflow file:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

BOOT-023 adds GitHub Actions checks that independently rerun this repository's own deterministic validation on every pull request and every push to `main`, so a local agent's claim that "tests pass" or "schemas validate" cannot substitute for actual CI evidence. CI never trusts a checked-in "passed" flag, evidence record, or narrative claim; it reruns the same deterministic commands a developer runs locally, against the exact commit under review.

This workflow is CI policy enforcement only. It does not compute merge readiness, evaluate branch protection, or perform AI semantic review — those remain owned by BOOT-024/BOOT-025 onward (see [BOOTSTRAP.md](../BOOTSTRAP.md)).

## Triggers

- `pull_request` targeting `main` — every PR revision reruns CI against its exact head commit.
- `push` to `main` — the post-merge commit is also verified independently of the PR's last recorded run.
- `workflow_dispatch` — manual rerun.

A newer push to the same ref cancels an in-flight run for that ref (`concurrency` with `cancel-in-progress: true`), so a merge-readiness reader always sees the status of the exact current head rather than a stale queued run for an earlier commit.

## Jobs and required status checks

Both jobs run on every trigger and are independent of each other (neither depends on the other's outcome). A repository administrator configuring branch protection should mark both as required status checks, using these exact GitHub check contexts:

| Job (workflow file id) | Check context (`<workflow name> / <job name>`) | What it proves |
| --- | --- | --- |
| `build-and-test` | `CI / Build and test (Node)` | The TypeScript build (`tsc`) succeeds and the full Node test suite (`node --test`) passes. |
| `schema-validation` | `CI / Schema and contract validation (Python)` | Every schema family accepts its own valid fixtures and rejects its own invalid fixtures, **and** every real authored `contracts/**/module-contract.json` and `tasks/definitions/*.task.json` record in the repository validates against its schema. |

Configuring branch protection itself (marking these checks "required" in the GitHub repository settings/API) is out of scope for BOOT-023 — see [Out of scope](#out-of-scope-follow-up) below.

## What each job runs

### `build-and-test`

1. `actions/checkout@v4` with `fetch-depth: 0` (full history, not the default shallow single-ref clone) — required because `tests/architecture-review.test.mjs`/`tests/qa-review.test.mjs` run `git merge-base` against `main`/`origin/main` in the real checked-out repository (they use `process.cwd()`, not an isolated fixture repo); under the default shallow checkout neither ref is resolvable and both test files fail with `Cannot resolve a merge base between 'main' (or 'origin/main') and revision 'HEAD'.` — this was caught by this workflow's own first CI run on this PR and reproduced locally with a real `git clone --depth 1` before being fixed
2. `actions/setup-node@v4` — Node.js `20` (matches this repository's `package.json` `engines.node: ">=20"`)
3. `npm ci` — installs exactly the versions pinned in `package-lock.json` (newly committed by BOOT-023; the repository had no lockfile before), failing rather than silently drifting if `package.json` and the lockfile disagree
4. `npm run build` — `tsc -p tsconfig.json`
5. `npm test` — `node --test` against every file in `package.json`'s `test` script, including the new `tests/ci-workflow.test.mjs`

### `schema-validation`

1. `actions/checkout@v4`
2. `actions/setup-python@v5` — Python `3.11`
3. `pip install -r schemas/requirements.txt`
4. `python schemas/validate_fixtures.py` — BOOT-003's existing schema-fixture validator (unchanged by BOOT-023)
5. `python schemas/validate_repository_contracts.py` — new BOOT-023 repository-invariant check: walks every real `contracts/**/module-contract.json` and `tasks/definitions/*.task.json` file and validates each against its `schemas/v1/*.schema.json` document, rather than only proving the schemas accept/reject their own hand-written fixtures. It fails loudly (rather than silently passing on zero matches) if no `module-contract.json` file is found at all, since that would indicate a stale glob rather than a genuinely empty repository.

## Running the same checks locally

A contributor can reproduce both jobs exactly, without pushing to GitHub, using the toolchain versions above:

```sh
# build-and-test
npm ci
npm run build
npm test

# schema-validation
pip install -r schemas/requirements.txt
python schemas/validate_fixtures.py
python schemas/validate_repository_contracts.py
```

There is no separate "CI-only" command and no separate "local-only" command: CI runs exactly these commands and nothing else, so a clean local run of both blocks is deterministic parity with CI for the same commit.

## Determinism and toolchain pinning

- No workflow step downloads or trusts a repository-authored "results" file; every check re-executes the underlying command against the checked-out commit.
- Actions are pinned to the exact major version this repository has validated against (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`) rather than `@main`/`@latest`, so a third-party action release cannot silently change CI behavior between runs. Toolchain versions (`node-version: "20"`, `python-version: "3.11"`) are pinned the same way, matching `package.json`'s `engines.node` and `schemas/requirements.txt`.
- Both jobs run on GitHub-hosted `ubuntu-latest` runners with no external network dependency beyond `npm install`/`pip install` from their respective public registries; no workflow step requires repository secrets.

## Out of scope follow-up

Per issue #25, BOOT-023 deliberately does not:

- configure branch protection / required-status-check enforcement in the GitHub repository settings — that requires elevated GitHub API/admin access this task does not assume is available, and is a policy decision rather than a workflow-authoring one; a repository administrator applies the check contexts documented above by hand until a later task automates it;
- compute merge readiness or gate merging (BOOT-024/BOOT-025);
- run AI semantic (QA/Architecture/UAT) review inside CI — that pipeline remains the `control-plane.qa-review`/`architecture-review`/`uat-review` gates (BOOT-018/019/020), invoked outside CI during the current manual bootstrap regime.

## Known consumers

- **future-merge-readiness-policy-engine (BOOT-024/BOOT-025)** — reads the `build-and-test` and `schema-validation` check results/contexts documented above as one input to computing merge readiness for the exact PR head, per the [`contracts/pr-lifecycle/README.md`](../contracts/pr-lifecycle/README.md) "known consumers" note that named this workflow as `future-ci-enforcement-workflow`.

See [`contracts/ci-enforcement/README.md`](../contracts/ci-enforcement/README.md) for the full module-contract bundle.
