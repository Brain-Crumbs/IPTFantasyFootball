# Manual workflow driver (BOOT-037)

Use the driver to prepare and run one operator-selected task at a time. It uses
the existing task registry, lifecycle, validation, independent review, PR/CI and
controlled merge gates. It does not launch AI sessions or declare Bootstrap v1
cutover. Do not point it at the stopped canary's exchange or resume that run.

## Set up once

Use Node 20+, npm and Git in a dedicated, clean project checkout on a local
filesystem that supports exclusive file creation, hard links, and same-directory
rename. Use a separate checkout from other writers. Verify your Git author and
`origin`; keep `.agent/` ignored. Run `npm ci` and `npm run build`. Run commands
from the checkout root, including when its path contains spaces.

```sh
npm run agent -- orchestrate init --base main \
  --checks 'Build and test (Node),Schema and contract validation (Python)' \
  --actor-prefix project-operator --developer-tools read_file,write_file,git_commit \
  --review-tools read_file,run_test --enforce-policies externally
```

PowerShell accepts the same command on one line. Setup prints the discovered
GitHub repository and every path, plus the five distinct actor labels and their
policies. If discovery cannot resolve the remote, specify `--repository owner/repo`.
Keep the repository's required CI checks; extra checks can be included. The
profile defaults to no agent network access. Enforce the displayed permission
scope in each fresh chat; actor labels do not enforce independence or tool access.
The driver uses the existing repository npm build/test validator resolver. It
does not execute validation plan prose from an issue.

Choose optional `--issues-dir`, `--responses-dir`, `--outbound-dir`,
`--archive-dir` or `--exchange-dir` under `.agent/driver/` during setup (use
forward slashes and quote spaces). Keep directories separate. Set
`--max-attempts` (1–10, default 3), `--retry-delay-ms` (default 100) and
`--role-timeout-ms` (default 5000). These bound adapter reads and infrastructure
retries. Time spent in a fresh chat does not consume attempts. Setup stores the
strict v1 profile at `.agent/driver/profile.json`; it never overwrites a
different profile. Restore the original profile to resume an existing session.
No credential goes in profile, issue Markdown, packet, or response. Export
`IPT_GITHUB_TOKEN` (or `GITHUB_TOKEN`) only in the trusted host process when GitHub
access is needed; Git push uses the operator's existing Git credentials.

## Prepare or select a task

Paste issue Markdown via stdin or save it and use `--issue-file`:

```sh
npm run agent -- orchestrate prepare --stdin < 'selected issue.md'
npm run agent -- orchestrate prepare --issue-file 'selected issue.md'
```

```powershell
Get-Content -Raw -LiteralPath 'selected issue.md' | npm run agent -- orchestrate prepare --stdin
```

You can also drop a `.md` file in the printed issues inbox and run
`orchestrate watch` (add `--once` for one scan). Wait for two scans at least
500 ms apart when using `--once`. Write to a temporary suffix then rename to
`.md` or `.json` after saving. Ordinary saves are accepted once two observations
match. A paused slow copy that looks stable can produce one rejection for those
bytes; the completed file is processed independently.

Use these exact headings, with `- none` for an intentionally empty list. Do not
omit required information. `Issue` can be a number or the complete issue URL
for this repository. Point requirements and contracts at already committed
project records; the driver does not create arbitrary artifacts from prose.
This example is for an isolated consumer fixture with no earlier eligible
task. Check `orchestrate next` on the actual checkout; the retained canary
definition is untouched and is not approval to run or change the old canary.

```markdown
# Deliver the documented output
Task ID: DEMO-001
Canonical branch: feature/demo-001
Issue: #101

## Objective
Deliver the documented marker for the operator.

## In scope
- marker.txt
## Out of scope
- Changing the workflow engine
## Dependencies
- none
## Allowed paths
- marker.txt
## Requirements
- DEMO-001-R1
## Acceptance criteria
- The operator sees the exact requested marker.
## Validation plan
- npm run build
- npm test
## Affected contracts
- control-plane.cli-shell
## Required review roles
- Developer
- QA
- Architect
- UAT/Product
- MergeController
```

Incomplete input emits a clarification handoff. Copy its `.diagnostic.json.md`
into a fresh chat and save the proposed response to the response inbox. It
contains the original issue, task schema, binding and response template. Do
not guess missing dependencies, issue metadata or requirements. Review the
proposal before saving it. It cannot make itself eligible or authorize a run.

The driver retains original Markdown and source hash, checks the proposed task
through the registry, DAG and context compiler, and stages it under `.agent`
before exposing the complete definition. Registration writes a Git commit
using an isolated index, then advances the exact clean local `main` ref and
restores only the committed definition into the checkout. It does not push or
assign. Interrupted registration is
reconciled by presenting the identical input again. Do not commit unrelated
changes or switch the integration branch during registration. Same-input
preparation reuses the session. Changes to existing issue content, task ID or
branch are conflicts, not replacement permission.

For an already committed task definition use
`orchestrate select DEMO-001 --issue-number 101`. Use `orchestrate next` to
inspect eligibility. `run SESSION` starts only if that task is the unchanged
deterministic next choice. Dependencies are satisfied only by native evidence,
not by issue closure. `status` lists prepared sessions; `status SESSION` shows
the original request, pending packet, last diagnostic and stage evidence.

## Run, review, and resume

1. Start `orchestrate watch SESSION` in a dedicated checkout. Alternatively
   run `orchestrate run SESSION` and repeat `orchestrate resume SESSION` for
   bounded scan/advance cycles. Startup scans existing inbox files.
2. Copy the whole outbound `*.handoff.json.md` into a fresh role chat with
   access to the named checkout and the displayed tools. The file contains the
   gate-compiled context, permissions, exact response schema and filled binding.
   Developer can commit on the canonical branch; reviewers leave it unchanged.
3. Save the raw response as any `.json` filename in the response inbox, or save
   a single fenced JSON block in `.md`. No surrounding text, multiple blocks,
   packet lookup, manual import command or request editing is needed. The
   driver checks the binding and source, then uses the existing manual adapter.
   A Developer result still binds to invocation revision; the intake fence and
   validators bind to the actual committed HEAD it produced.
4. Inspect the receipt and next packet. A malformed/unaccepted response can be
   corrected against the same packet using the original role schema and
   template included in the bound repair handoff. A terminal result stays immutable. A
   failed review enters legal rework; import its typed `rework` proposal or run
   `orchestrate rework SESSION`. The linked successor uses a new judgment and
   preserves the original assignment and predecessor evidence.
5. For failed validation or terminal provider error needing a reset, stop and
   verify all local **and external** writers. Use the audited BOOT-032 path:
   `orchestrate recover SESSION --quiescent --reason '...' --authorization-ref REF`
   with trusted `IPT_RECOVERY_ADMIN_ACTORS` configuration. Then use
   `orchestrate rework SESSION`. The proposal does not authorize the reset.
   See [RECOVERY.md](RECOVERY.md). If a diagnosis is an external prerequisite,
   fix that prerequisite and return `recheck`, or explicitly resume the same
   session. The driver does not loop on unchanged CI, credentials or approval.

`--json` emits one existing envelope on stdout. Watch progress goes to stderr;
successful observations of waiting/stopped gates return 0 with the explicit
state in data, invalid usage returns 2, blocked command operations return 4.
`Ctrl+C` stops waiting and drains the active gate; external sessions can still
run and must be stopped separately. Another watcher can scan later without
repeating completed operations. After abrupt termination inside a mutation,
inspect `orchestrate inspect-writer` and use `recover-writer --quiescent
--lock-hash HASH --reason TEXT` only after confirming that all writers stopped.
If the native orchestration token also remains, use `recover-run SESSION
--quiescent --reason TEXT`. Neither action deletes journals or evidence.

## Publish and complete

When `MERGE_READY`, `orchestrate publish SESSION` authorizes a non-force push
of the reviewed SHA and creation/update of the one canonical draft PR. Check
the remote, issue, branch, base and exact head. Origin must have one read and
one push destination, with no Git rule that rewrites either checked URL.
`orchestrate ready SESSION`
separately authorizes ready conversion of that existing PR. After the exact
head checks are green and approval is established, supply the trusted host
value `IPT_DRIVER_MERGE=owner/repo#NUMBER@FULL_SHA` and resume the same session.
For PowerShell use `$env:IPT_DRIVER_MERGE = 'owner/repo#NUMBER@FULL_SHA'`. A
different head, failed/pending CI, conflicting PR or withheld authorization
cannot complete. Keep other GitHub writers quiescent around publication and
ready conversion. GitHub's ready API does not provide a compare-and-swap SHA;
the driver checks the target before and after, and merge uses GitHub's SHA
condition. The native controller owns MERGED, lock release, DONE, and
reconciliation of a lost merge response. An already confirmed merge does not
issue a second PUT. Reconciliation is scoped to the exact authorized intent
recorded before the first attempt; an earlier merged PR on the same branch or
SHA cannot complete this session.

The completion handoff reports the next eligible candidate. Switch back to
clean `main`, refresh it as appropriate, and explicitly select the next
prepared session. The previous request is never reused for another task.

## Data, compatibility, and rollback

All new driver metadata lives under `.agent/driver`: separate intake/session,
handoff, observation, archive and canonical exchange records. The gate stores
remain under `.agent/state`. Keep both in backups while writers are stopped.
Receipt and session records coordinate retries; they are not review evidence
or merge grants. Legacy `manual export/import/run`, canary rehearsal and CLI
envelopes remain supported. New role handoffs are companions to unchanged
manual packet/result formats. Do not import directly into a driver exchange:
the driver must bind the accepted result to its own current source fence.

To roll back, stop/drain the driver and external role sessions. Disable the
entry point or use the prior checkout. Preserve the driver and gate directories
read-only with their original Git history. Older orchestration journal readers
do not understand the successor's additive assignment fields; keep active
BOOT-037 attempts with the compatible engine, or quarantine the whole stopped
project state for reconciliation. Never delete journals, reset counters or
overwrite evidence to make an older version resume. Fixture GitHub and
scripted role outcomes in tests prove behavior, not live independent approval.
