# Local/manual agent adapter operator guide

**Task:** [BOOT-029 / issue #31](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/31)
**Parent:** [Bootstrap issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)
**Module:** [control-plane.local-agent-adapter](../contracts/local-agent-adapter/README.md)

## What this does

`FileManualAgentProvider` hands one complete compiled role context to an operator-managed external/desktop AI session using JSON files. It accepts that session's structured result and returns it through the existing `AgentProvider`/`AgentRunner` interface. It requires no AI vendor account, SDK, API credential, or UI automation in this repository. Offline fixtures can exercise the entire transport.

The adapter does not choose a task, compile replacement context, execute tools, enforce an external sandbox, write validation/review evidence, advance lifecycle, create a PR, or merge. Import means **the runner can read the result**, not **the task is approved**. Existing deterministic gates retain those authorities. A generic `agent orchestrate` command remains reserved; the existing orchestration library accepts this provider.

Read `AGENTS.md`, `CONSTITUTION.md`, `BOOTSTRAP.md`, the master issue, and the explicitly assigned task before real work. The continuing manual bootstrap assignment rules apply. Examples below are transport demonstrations, not independent approval or evidence for a real task.

## Prerequisites and trust boundary

- Node.js 20+ and npm; run `npm install` and `npm run build` from the repository root.
- A local directory writable only by the intended operator/runner, with no symlink in its directory path. `.agent/state/manual-exchange` is a suitable ignored repository-local location; a private directory outside the checkout is also supported. Use the same absolute directory in both terminals/processes.
- For real work, an authentic `AgentRunRequest` from the workflow's current compiled context and a role-appropriate external environment. Do not replace a gate-generated package with the minimal demo package below.
- A fresh role-specific session for each packet. The same model/provider may be reused, but the Developer session may not self-approve as QA, Architect, or UAT/Product. Keep reviewer actor identities distinct and stable. Actor strings and hashes are not proof that a session was independent.
- The operator must enforce `toolPermissionPolicy.allowedTools`, `deniedTools`, and `networkAccess` in the external environment before beginning. Tool names are deployment-specific. The packet is requested policy, not a sandbox or grant of additional access. If that policy cannot be enforced, do not execute the packet; return an appropriate structured blocker or external error.

Treat packets/results as potentially sensitive repository content. They contain full task/context artifacts, not just pointers. Transfer only to an external session already authorized to receive that information, and do not embed credentials. Local files and SHA-256 identities are not signatures or authentication: anyone able to replace the exchange files is inside this adapter's trust boundary. Hash/identity checks detect mismatches and corruption; they do not verify who performed a review or whether reported evidence is true.

## Three commands

```sh
npm run --silent agent -- --json manual export REQUEST.json EXCHANGE_DIR
npm run --silent agent -- --json manual import PACKET_ID RESULT.json EXCHANGE_DIR
npm run --silent agent -- --json manual run REQUEST.json EXCHANGE_DIR
```

All paths are resolved from the repository root/current CLI working directory. The same JSON envelope convention as other commands applies; see [CLI.md](CLI.md). A request file contains `AgentRunRequest` JSON without `signal`; process cancellation cannot be serialized. Request/result input paths must be regular files no larger than 4 MiB UTF-8; pipes/devices are rejected before reading. Optional `timeoutMs` is a positive integer in `1..2147483647` milliseconds.

- `export` validates/persists a packet and returns `data: { packetId, packetPath, resultPath }`. Re-exporting the exact logical request reuses its packet. Read `packetPath` for the complete payload.
- `import` validates the result against the stored packet and atomically publishes it. It returns `data: { packetId, resultPath, reused, status }`. An identical import is safe (`reused: true`); a different result for that packet is rejected.
- `run` exports/reuses the packet, waits for an imported result through `AgentRunner`, and returns the `AgentRunResult` as `data`. It never runs lifecycle gates. In JSON mode stdout contains one final envelope, not progress messages. Export first so the packet ID/path is available while `run` waits. Ctrl-C requests graceful cancellation of the local wait.

The exchange layout is flat:

```text
EXCHANGE_DIR/
  <64-lowercase-hex-packet-id>.packet.json
  <64-lowercase-hex-packet-id>.result.json  # appears after validated import
```

Use the import command rather than writing a result directly into its final exchange path. Prepare the external response in a separate file so the waiting process never sees a partially written response. Do not edit a persisted packet or overwrite an accepted result. Stored exchange records must remain the adapter's canonical JSON plus newline; reformatting them by hand is treated as corruption, even when the parsed JSON would match. Input request/response files may use ordinary JSON formatting.

## Offline round-trip: complete runnable example

Run these commands from the repository root in a POSIX shell. This creates only temporary demonstration files. Its fictional revision and minimal context are valid transport fixtures, not a current repository review. The demonstration result's `PASS` is only a fixture value.

```sh
npm run build
DEMO_DIR=$(mktemp -d)
export DEMO_DIR
cat > "$DEMO_DIR/request.json" <<'JSON'
{
  "taskId": "BOOT-029",
  "role": "QA",
  "revisionIdentity": "1111111111111111111111111111111111111111",
  "runId": "manual-demo-qa-1",
  "actorId": "independent-demo-qa",
  "contextPackage": {
    "schemaVersion": "1.0.0",
    "taskId": "BOOT-029",
    "role": "QA",
    "sourceRevision": "1111111111111111111111111111111111111111",
    "task": {
      "taskId": "BOOT-029",
      "title": "Offline manual transport demonstration"
    },
    "artifacts": [],
    "manifest": { "included": [], "excluded": [] }
  },
  "toolPermissionPolicy": {
    "allowedTools": [],
    "deniedTools": ["write_file"],
    "networkAccess": "none"
  },
  "timeoutMs": 60000
}
JSON

node dist/cli/cli.js --json manual export \
  "$DEMO_DIR/request.json" "$DEMO_DIR/exchange" > "$DEMO_DIR/export.json"
PACKET_ID=$(node --input-type=module -e \
  'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).data.packetId)' \
  "$DEMO_DIR/export.json")
export PACKET_ID
cat "$DEMO_DIR/exchange/$PACKET_ID.packet.json"
```

For real work, hand that whole packet to the independent role session, enforce its permissions, and ask it to return JSON matching the result schema. For this offline demonstration, generate a result fixture by copying the packet's binding exactly:

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
const root = process.env.DEMO_DIR;
const id = process.env.PACKET_ID;
const packet = JSON.parse(fs.readFileSync(`${root}/exchange/${id}.packet.json`, 'utf8'));
const result = {
  schemaId: 'ipt.local-agent-result',
  schemaVersion: '1.0.0',
  ...packet.resultBinding,
  status: 'COMPLETED',
  result: {
    providerId: packet.providerId,
    taskId: packet.taskId,
    role: packet.role,
    revisionIdentity: packet.revisionIdentity,
    runId: packet.runId,
    outcome: 'PASS',
    details: { summary: 'Offline transport fixture only; no real QA approval.' },
    findings: [],
    evidenceRefs: [],
    occurredAt: '2026-10-07T00:00:00Z'
  }
};
fs.writeFileSync(`${root}/response.json`, JSON.stringify(result, null, 2));
JS

node dist/cli/cli.js --json manual run \
  "$DEMO_DIR/request.json" "$DEMO_DIR/exchange" > "$DEMO_DIR/run.json" &
RUN_PID=$!
node dist/cli/cli.js --json manual import \
  "$PACKET_ID" "$DEMO_DIR/response.json" "$DEMO_DIR/exchange"
wait "$RUN_PID"
cat "$DEMO_DIR/run.json"
# Identical imports reuse the accepted record; no second judgment is created.
node dist/cli/cli.js --json manual import \
  "$PACKET_ID" "$DEMO_DIR/response.json" "$DEMO_DIR/exchange"
```

Expected: export/import/run each succeeds with `ok: true`; run's `data` preserves task/role/revision/run and has `providerId: "local-manual-agent"`, `outcome: "PASS"`; the second import reports `reused: true`. Import may occur before or after `run` begins waiting. Neither order modifies authoritative task state.

For a negative check, change `revisionIdentity` in a copy of `response.json` and attempt import. Expect nonzero exit and a `MANUAL_ADAPTER_ERROR` message prefixed `MALFORMED_RESULT`, while the accepted file stays unchanged. The focused automated suite covers wrong task/role/run/actor/context/input identities, malformed shapes, duplicate conflicts, cancellation/error outcomes, and runner/orchestration integration:

```sh
npm test
python3 schemas/validate_fixtures.py
python3 schemas/validate_repository_contracts.py
```

## Packet and result contract

Schema files are [local-agent-packet.schema.json](../schemas/v1/local-agent-packet.schema.json) and [local-agent-result.schema.json](../schemas/v1/local-agent-result.schema.json), both record version `1.0.0`. Runtime validation also enforces cross-field equality, hashes, and result semantics that cannot be established by a shape-only schema check.

The packet contains the exact complete `contextPackage` (task view, artifact contents, and included/excluded manifest), exact `toolPermissionPolicy`, human-readable `instructions`, and `resultBinding`. Copy every field in `resultBinding` unchanged into the envelope:

- `packetId`, `providerId`, `taskId`, `role`, `revisionIdentity`, `runId`, `actorId`
- `contextIdentity`: deterministic SHA-256 identity of the complete context
- `inputIdentity`: deterministic SHA-256 identity of `{ contextPackage, toolPermissionPolicy }`

Do not compute or replace hashes manually. JSON object-key order is canonicalized for identities; array order and content remain significant. The packet's logical task/role/revision/run/actor identity cannot be rebound to changed context or policy by re-exporting it. `timeoutMs` and an in-memory abort signal govern waiting, not the external work identity.

Every envelope is exactly one of:

| Transport status | Required payload | Runner behavior |
| --- | --- | --- |
| `COMPLETED` | `result: AgentRunResult` | Returns the validated semantic judgment. |
| `CANCELLED` | `error: { "message": "External session was cancelled." }` | Throws `CANCELLED`, `recoverable: false`. |
| `ERROR` | `error: { "message": "External session failed before a judgment.", "recoverable": false }` | Throws `PROVIDER_ERROR`, `recoverable: false`. |

Use the same copied binding and schema fields for all three. `COMPLETED` requires `result` and forbids `error`; `CANCELLED`/`ERROR` require `error` and forbid `result`. The result's task/role/revision/run/provider must match its enclosing packet. Actor and context/input identities live in the envelope, not additional `AgentRunResult` fields.

An `AgentRunResult` uses `outcome: PASS | FAIL | BLOCKED`, object `details`, array `findings`, array `evidenceRefs`, and an RFC 3339 `occurredAt` with uppercase `T` separating date and time. Each finding has unique `findingId`, recognized severity (`INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), `observed`, and `expected`; optional requirement/contract/evidence references and remediation retain their existing review-framework meaning. `FAIL` and `BLOCKED` require `nonPass: { reason, remediation }`, optionally `blockingPrerequisites`. Preserve actual findings and evidence references; never fabricate evidence IDs. A structurally valid import may still fail a later review gate, such as a `PASS` with unresolved blocking findings.

`COMPLETED` means the external session delivered a judgment, even if that judgment is `FAIL` or `BLOCKED`. Do not turn a genuine review rejection into `ERROR` to seek another attempt. Conversely, an external crash with no judgment is an `ERROR`, not a fabricated review `FAIL`.

Only lossless JSON values are supported: plain objects/arrays, strings, booleans, null, and finite numbers other than negative zero. No undefined, functions, BigInt, symbols, accessors, hidden properties, cycles, sparse arrays, or non-plain objects. The transport is bounded to 4 MiB UTF-8, depth 64, and 100,000 JSON nodes. Exact limits apply to the complete packet/envelope, so leave space for binding and instruction overhead. These transport limits do not narrow the general neutral runner contract for other providers.

## Real role execution and revision handling

1. Obtain the exact request/context from the owning workflow. Verify task assignment, canonical branch, current revision, role, actor, run, and requested tool policy. Export the request and keep the original request file.
2. Open a fresh role-specific session. Supply the entire packet and its instructions. Do not add prior developer narrative to a reviewer session or omit the Architect's producer/consumer context.
3. Confirm the external environment enforces the packet's tool/network policy. Reviewers inspect the specified revision and must not change source or HEAD while reviewing.
4. Execute only that role's authorized scope. Return a structured envelope using the original binding, with honest findings, evidence references, and timestamp. Free-form prose, Markdown fences, or a bare `AgentRunResult` without its envelope are not importable results.
5. Verify the session produced the intended packet's response, save it outside the exchange result destination, and run `manual import` against that exact packet ID.
6. An active `manual run` or orchestration provider wait reads it automatically. A stopped process must be explicitly resumed; importing alone starts no runner or lifecycle gate.

A Developer may create a new commit while performing the implementation. Its returned `revisionIdentity` still binds to the **invocation packet's original revision**, not a rewritten packet or claimed new approval. The existing orchestrator's deterministic Developer Validation then resolves actual current HEAD; subsequent independent review packets are compiled for that exact new revision. Reviewer packets may never be relabeled to another revision. Developer `PASS` is traceability only and cannot replace validation.

## Injecting into the existing orchestration library

The manual provider is a replacement for an injected provider; no orchestration domain change is required. After `npm run build`, an existing authorized orchestration entry point can use:

```js
import { FileManualAgentProvider } from './dist/local-agent-adapter/index.js';
import { createLocalOrchestrationEngine } from './dist/orchestration-engine/index.js';

const repositoryRoot = process.cwd();
const exchangeRoot = `${repositoryRoot}/.agent/state/manual-exchange`;
const provider = new FileManualAgentProvider(exchangeRoot, {
  repositoryRoot,
  pollIntervalMs: 250
});

// existingOptions supplies the already-authorized GitHub integration and role
// tool/timeout/actor policies. Never put its token in a role packet or result.
const engine = await createLocalOrchestrationEngine(repositoryRoot, {
  ...existingOptions,
  provider
});
// existingRequest preserves ownerId, runId, occurredAt, idempotencyKey and
// cancellation/deadline choices across explicit same-run resumes.
const report = await engine.run(existingRequest);
```

This is an integration fragment for an existing configured caller, not a credential-free full-pipeline script. `createLocalOrchestrationEngine` still requires `owner`, `repo`, and `token` for its pre-existing GitHub gates. The adapter itself needs none. The engine can perform authorized workflow transitions and controlled merge when their existing gates permit; do not run it on live work just to test the transport. The offline round-trip and integration tests use fixture/fake gates and do not claim a live merge occurred.

While an engine is running, inspect the same directory from a second terminal. This discovery command prints each packet still lacking an imported result; it does not modify files or start a role:

```sh
node --input-type=module - .agent/state/manual-exchange <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
for (const name of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
  if (!name.endsWith('.packet.json')) continue;
  const p = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  if (!fs.existsSync(path.join(root, `${p.packetId}.result.json`))) {
    console.log(`${p.role} ${p.taskId} ${p.runId}\n  ${path.join(root, name)}`);
  }
}
JS
```

Confirm each discovered packet belongs to the active engine run before executing it; a pending file can remain from an interrupted run. Open each new role in a fresh session and import using the same `manual import` command. Do not create or guess the next stage's request. The engine supplies the appropriate gate-compiled package and stable `${runId}::<stage-id>` identity when that stage is eligible. Deterministic merge readiness/controlled merge do not ask a desktop session for discretionary approval.

## Cancellation, retry, and recovery

- Default polling is 250ms; library `pollIntervalMs` accepts integers `1..60000`. A result is checked from the local exchange, not fetched from a vendor.
- Ctrl-C or a supplied abort signal stops the current local wait with `CANCELLED`; `timeoutMs` stops it with recoverable `TIMEOUT`. Neither event writes a terminal result file. The packet remains available for an explicit same-identity resume. The external session is not force-stopped: stop it separately and check whether tools are still running before retrying.
- A later validated import may be read by a new same-identity wait. It cannot revive an already-settled cancelled/timed-out promise or advance a stopped engine by itself.
- Explicitly imported `CANCELLED` and `ERROR` envelopes are immutable terminal responses. Both are non-recoverable; `ERROR` requires `recoverable: false`. A same-identity retry reads the same terminal result and does not launch or authorize another external execution. Resolve the underlying problem and follow the owning workflow's decision for a genuinely new run; do not overwrite/delete the accepted result or change IDs to evade a failed gate.
- Identical packet exports/imports are idempotent. Changed context/tool policy under the same logical packet identity is `INVALID_REQUEST`; mismatched binding, malformed imported data, tampered persisted content, and conflicting imports are `MALFORMED_RESULT`. Correct an unaccepted response file against the original packet. Never “repair” an accepted response in place.
- Filesystem failures surface as `PROVIDER_ERROR`; inspect permissions and the actual path before retrying. Symlinked/non-regular exchange files and malformed records are blockers. Keep diagnostic records; no general repair, lock stealing, or state reconstruction is supplied.
- BOOT-028 owns durable orchestration retry budgets, execution locks, journals, and same-key resume. Retain key/owner/run and exchange files; `manual run` itself has no orchestration journal or automatic retry policy. Follow the [orchestration recovery procedure](../contracts/orchestration-engine/README.md) for an interrupted engine, including verifying all runners stopped before touching a stale lock.

Export/import/run success proves transport behavior only. It never establishes independent QA/Architecture/UAT approval, an authoritative evidence record, a live canary merge, or Bootstrap v1 cutover.
