# CI Enforcement

**Task:** BOOT-023 / issue #25
**Parent architecture:** issue #1
**Module ID:** `control-plane.ci-enforcement`

## Identity and purpose

- **Module ID:** `control-plane.ci-enforcement`
- **Module version:** `1.0.0`
- **Manifest:** `./module-contract.json`

`control-plane.ci-enforcement` is the GitHub Actions workflow (`.github/workflows/ci.yml`) and its supporting script (`schemas/validate_repository_contracts.py`) that independently rerun this repository's deterministic checks against every pull-request revision and every `main` push, so a local agent's claim that validation passed cannot substitute for actual reproducible CI evidence. Unlike every other module in `contracts/`, this module's "interface" is a workflow file plus a repository-invariant script rather than a TypeScript API; its structural contract is expressed as job/check identity and command behavior rather than exported types.

## Structural contract

- Workflow file: `.github/workflows/ci.yml`, workflow name `CI`
- Job `build-and-test` (check context `CI / Build and test (Node)`) — checks out full history (`fetch-depth: 0`), then runs `npm ci`, `npm run build`, `npm test`
- Job `schema-validation` (check context `CI / Schema and contract validation (Python)`) — runs `python schemas/validate_fixtures.py`, then `python schemas/validate_repository_contracts.py`
- Triggers: `pull_request` (branches: `main`), `push` (branches: `main`), `workflow_dispatch`
- `schemas/validate_repository_contracts.py` — a standalone script (no importable API; invoked as `python schemas/validate_repository_contracts.py`) that exits `0` and prints `PASS: <n> repository contract/task record(s) validated against their schema` on success, or exits `1` and prints one `FAIL: <path>: <reason>` line per invalid/malformed/missing record on failure

## Capabilities

- Independently rerun the repository's own build (`tsc`), full test suite (`node --test`), and schema-fixture validation (`schemas/validate_fixtures.py`) against the exact commit under review, rather than trusting a developer's local report.
- Validate every real authored `contracts/**/module-contract.json` record against `schemas/v1/module-contract.schema.json`, and every real authored `tasks/definitions/*.task.json` record against `schemas/v1/task.schema.json` — a repository-invariant check `schemas/validate_fixtures.py` does not perform, since that script only proves the schema *definitions* accept/reject their own hand-written fixtures.
- Fail CI deterministically on any required-check violation, with the failing job/step and the specific failing record identified.
- Cancel an in-flight run for a ref when a newer commit is pushed to the same ref, so a merge-readiness reader always observes the status of the exact current head.
- Document exact check contexts and local-parity commands so `npm ci && npm run build && npm test` plus `pip install -r schemas/requirements.txt && python schemas/validate_fixtures.py && python schemas/validate_repository_contracts.py` reproduce CI exactly (see `docs/CI.md`).

## Behavioral constraints and ranges

- Both jobs run unconditionally on every `pull_request` targeting `main`, every `push` to `main`, and manual `workflow_dispatch` — neither job is skipped based on which files changed.
- `build-and-test`'s checkout uses `fetch-depth: 0` rather than the action's default shallow single-ref clone: `tests/architecture-review.test.mjs`/`tests/qa-review.test.mjs` run `git merge-base` against `main`/`origin/main` in the real checked-out repository (`process.cwd()`, not an isolated fixture repo), which is unresolvable under a shallow clone. This was caught by this workflow's own first CI run and reproduced locally with a real `git clone --depth 1` before the fix.
- `build-and-test` fails (non-zero exit) if `npm run build` or `npm test` exits non-zero; it never proceeds to report success after a failing step, since GitHub Actions steps run sequentially and a failing step halts the job by default.
- `schema-validation` fails if `schemas/validate_fixtures.py` or `schemas/validate_repository_contracts.py` exits non-zero.
- `schemas/validate_repository_contracts.py` fails (`SystemExit(1)`) if: a scanned JSON file is not valid JSON; a scanned record does not validate against its schema; or zero `contracts/**/module-contract.json` files are found (a stale/broken glob is a failure, not a vacuous pass). Zero `tasks/definitions/*.task.json` files is not itself a failure, since the repository-native task registry may legitimately hold no records yet (see `tasks/README.md`).
- No workflow step reads a checked-in "evidence" or "passed" file as a substitute for rerunning the underlying check; every reported result comes from that run's own process exit code.
- Actions are pinned to major-version tags (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5`); toolchain versions are pinned explicitly (`node-version: "20"`, `python-version: "3.11"`), matching `package.json`'s `engines.node` and `schemas/requirements.txt`.

## Invariants

- This module performs no lifecycle-state transition, no merge, and no merge-readiness computation.
- This module decides no QA/Architecture/UAT judgment; it enforces only deterministic, reproducible checks.
- Every check a job performs is also runnable locally with the exact command listed in `docs/CI.md`, so CI never depends on GitHub-only state.
- `schemas/validate_repository_contracts.py` never mutates a scanned file; it is read-only.

## Dependencies

### Allowed

- `control-plane.task-registry` (schema family only, via `schemas/v1/task.schema.json`)
- `contracts/*` (schema family only, via `schemas/v1/module-contract.schema.json`)
- `schemas/v1/*`
- GitHub-hosted `actions/checkout`, `actions/setup-node`, `actions/setup-python`

### Forbidden

- `agent-provider/*`
- `merge-controller/*`
- `fantasy-product/*`

This module reads repository files to validate them; it never depends on another module's runtime behavior beyond the already-existing `npm run build`/`npm test`/`schemas/validate_fixtures.py` commands those modules' own `package.json`/`schemas/` entries define.

## Known consumers

### future-merge-readiness-policy-engine (BOOT-024/BOOT-025)

Why this consumer depends on the module:

- It can read the `build-and-test`/`schema-validation` check results for the exact PR head — discoverable through the canonical PR `control-plane.pr-lifecycle` (BOOT-022) ensures — as one deterministic input to computing merge readiness, without reimplementing CI status evaluation itself.

Required capabilities:

- Both jobs report a result (`success`/`failure`) tied to the exact commit SHA GitHub checked out, not a cached or partial result.

## Consumer expectations and accepted ranges

### future-merge-readiness-policy-engine

Expectations:

- A `success` result for both jobs on a given commit means that commit's build, full test suite, schema fixtures, and real contract/task records all passed at that exact revision.

Accepted producer-output ranges:

- Each job's check status is exactly one of GitHub's own `success`/`failure`/`cancelled`/`skipped` states for that commit; this module introduces no additional custom status vocabulary.

## Consumer-required reachable ranges

### future-merge-readiness-policy-engine

- A `success` result must remain reachable for a commit whose code genuinely satisfies every check (this module must never fail a passing commit).
- A `failure` result must remain reachable for a commit whose code genuinely violates any required check (this module must never silently pass a failing commit).

## Examples

- A PR that introduces a failing `node --test` assertion receives a failing `build-and-test` check; `schema-validation` is unaffected and still reports its own independent result.
- A PR that edits `contracts/pr-lifecycle/module-contract.json` to remove a required field (for example `knownConsumers`) receives a failing `schema-validation` check via `schemas/validate_repository_contracts.py`, identifying the exact file and the missing field.
- A clean PR that changes only documentation receives a passing `build-and-test` and a passing `schema-validation`, using the exact toolchain versions documented in `docs/CI.md`.
- A push directly to `main` (for example a merge commit) reruns both jobs against that merge commit independently of whatever the source PR's last recorded run reported.

## Edge cases

- A malformed (non-JSON) `contracts/**/module-contract.json` file fails `schemas/validate_repository_contracts.py` with a JSON-parse error identifying the file, rather than crashing the script or being silently skipped.
- If every `contracts/**/module-contract.json` file were ever deleted, `schemas/validate_repository_contracts.py` fails explicitly (`expected at least one file ... found none`) rather than reporting a vacuous pass.
- A second commit pushed to the same PR while an earlier run is still in progress cancels that earlier run (`concurrency.cancel-in-progress: true`) rather than letting a stale run's result be read after a newer one exists for the same ref.

## Out-of-scope follow-up

Per issue #25, this module deliberately does not: configure GitHub branch-protection required-status-check enforcement (an administrative/API action outside this task's assumed access — see `docs/CI.md` "Out of scope follow-up"); compute merge readiness or merge policy (BOOT-024/BOOT-025); or run AI semantic (QA/Architecture/UAT) review inside CI, which remains the `control-plane.qa-review`/`architecture-review`/`uat-review` gates invoked outside CI during the current manual bootstrap regime.

## Change-impact checklist

- [ ] Did a job name, check context, or trigger change (would invalidate documented branch-protection check names)?
- [ ] Did a capability disappear or become conditional (for example, a job made conditional on changed files)?
- [ ] Did the pass/fail range of `schemas/validate_repository_contracts.py` narrow or expand (for example, a new record family added or an existing one silently dropped)?
- [ ] Did an invariant change (for example, CI began trusting a checked-in evidence file)?
- [ ] Did an edge-case behavior change (for example, zero matched files began passing instead of failing)?
- [ ] Did dependency direction change?
- [ ] Is the producer (CI result) reachable range still contained by the merge-readiness-engine's accepted range?
- [ ] Is the merge-readiness-engine's required reachable range (`success` for genuinely passing code, `failure` for genuinely failing code) still reachable?

If structural compatibility remains but semantic behavior changes (for example, which checks a job runs, or what makes `schemas/validate_repository_contracts.py` fail), explicitly route the change for downstream semantic compatibility review — BOOT-024/BOOT-025 are the named known consumer above.
