# Role Model and Review Authority

**Task:** BOOT-002 — Role model and review authority definitions  
**Parent architecture:** [Issue #1](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1)  
**Task issue:** [Issue #4](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/4)

This document defines the human- and machine-implementable authority boundaries for the bootstrap workflow roles. It is a normative role contract for later schema, context-compiler, review, and merge-policy work. It does not implement any review executor, agent provider, lifecycle engine, or schema.

## 1. Cross-role invariants

All roles operate under the repository constitution and the exact task/revision under review.

1. **No self-approval.** The agent/session that produced an implementation may perform developer self-validation, but it may not issue QA, Architecture, UAT/Product, or Merge Controller approval for that implementation.
2. **Fresh role context.** When the same underlying model/provider is reused across roles, each role is invoked as a fresh role session with the context explicitly authorized for that role. Conversation memory is not authority.
3. **Revision-bound judgments.** Every review judgment is about one exact implementation revision. A later code change may invalidate prior judgments. A reviewer must never approve a moving or unspecified target.
4. **Evidence before status.** Role outputs are evidence inputs. They do not, by themselves, authoritatively transition lifecycle state. Later deterministic workflow code owns transitions.
5. **Structured outputs.** Every role judgment must be representable later as structured data containing at least: role, task ID, exact revision identity, outcome, findings, evidence references, and rationale/remediation where applicable.
6. **Role-local authority only.** A PASS from one role does not imply PASS for another role. QA correctness cannot substitute for Architecture semantic compatibility; Architecture fit cannot substitute for UAT outcome validation.
7. **Provider neutrality.** These roles describe responsibilities and authority, not prompts or capabilities of one model vendor.

## 2. Common outcome vocabulary

Later schemas may refine field names, but role judgments must map to these semantics:

- **PASS** — the role's required review perspective is satisfied for the exact revision.
- **FAIL** — the revision violates one or more requirements within that role's authority and requires rework before that gate may pass.
- **BLOCKED** — the reviewer cannot make a trustworthy judgment because required context, evidence, environment, dependency, or revision identity is unavailable or contradictory.

A finding should be independently addressable and include, when applicable:

- stable finding identifier;
- severity;
- requirement, contract, invariant, or scenario affected;
- evidence reference;
- observed condition;
- expected condition;
- required remediation or decision.

## 3. Developer

### Purpose

Implement the assigned task within declared scope and produce a reviewable, validated revision.

### Authorized inputs / context

The Developer should receive only the implementation context needed for the assigned task:

- task objective, scope, dependencies, requirements, and acceptance criteria;
- canonical branch and allowed/expected file areas;
- directly relevant module contract;
- direct dependency contracts needed to implement;
- examples, fixtures, and deterministic validation requirements required by the task.

The Developer does **not** need broad unrelated consumer/system context unless the task explicitly requires it to implement correctly.

### Allowed actions

- modify files within authorized scope;
- add focused implementation tests/checks required by the task;
- run deterministic validation available during the current bootstrap phase;
- inspect direct dependencies needed for implementation;
- perform developer self-review and report implementation risks/assumptions;
- produce a reviewable revision and handoff evidence.

### Prohibited actions

- approve its own work as QA, Architect, UAT/Product, or Merge Controller;
- mark its implementation DONE by assertion;
- substitute developer self-review for an independent gate;
- silently broaden scope or repair unrelated defects;
- reinterpret failed downstream review as success;
- approve a revision other than the exact revision it actually produced/validated.

### Output

A Developer handoff must be representable as structured data with:

- role = Developer;
- task ID;
- exact revision identity;
- implementation summary;
- changed surfaces;
- acceptance-criteria evidence mapping;
- validation checks/results;
- known limitations, assumptions, and risks;
- handoff readiness status.

### Authority

The Developer has implementation authority only. It may state that developer validation is complete, but it has **no independent approval authority** over QA, Architecture, UAT/Product, merge readiness, or completion.

## 4. QA Reviewer

### Purpose

Determine whether the exact revision behaves correctly against task requirements, acceptance criteria, negative cases, edge cases, and regression expectations.

### Authorized inputs / context

QA should receive:

- task requirements and acceptance criteria;
- exact revision/diff under test;
- supported test interfaces, fixtures, and environment needed to exercise behavior;
- deterministic developer-validation evidence for that revision;
- relevant local contracts required to interpret expected behavior.

QA should not rely on the Developer's narrative justification as authority. It may inspect that narrative only when explicitly required as evidence.

QA normally receives narrower system context than the Architect. It needs enough dependency context to exercise behavior, but not broad consumer intent that would blur the QA/Architecture boundary.

### Allowed actions

- execute or inspect tests and reproducible scenarios;
- verify happy paths, edge cases, negative cases, regressions, and acceptance criteria;
- challenge unsupported developer claims with direct evidence;
- issue PASS, FAIL, or BLOCKED within QA authority;
- record reproducible findings.

### Prohibited actions

- implement fixes while acting as QA;
- waive acceptance criteria because the implementation appears reasonable;
- approve semantic system fit merely because local behavior passes;
- approve intended product outcome merely because tests pass;
- approve an unspecified or superseded revision.

### Output

A QA review result must be representable as structured data with:

- role = QA;
- task ID;
- exact revision identity;
- outcome = PASS | FAIL | BLOCKED;
- acceptance criteria/scenarios exercised;
- evidence references;
- findings;
- regression/negative-case coverage;
- remediation required for non-PASS results.

### Authority

QA alone may issue the **QA judgment** for the exact revision. QA does not issue Architecture, UAT/Product, or merge-readiness approval.

## 5. Architecture Reviewer

### Purpose

Determine whether the exact revision preserves or deliberately and safely changes the repository's architecture, dependency rules, semantic module contracts, and producer/consumer compatibility.

### Authorized inputs / context

The Architect is explicitly authorized to receive **broader cross-module context than both Developer and QA**, including:

- task requirements and exact revision/diff;
- affected module structural and semantic contracts;
- architectural invariants and dependency policies;
- direct upstream dependencies;
- direct downstream consumers;
- relevant consumer requirements, acceptance criteria, assumptions, and expected capability/range;
- QA results as evidence, but never as authority over Architecture.

This broader context is intentional. Architecture review must be able to detect semantic breakage even when local tests and public types remain unchanged.

### Allowed actions

- inspect producer and consumer contracts together;
- inspect dependency direction and boundary rules;
- evaluate behavioral/range changes that preserve structural types;
- determine whether downstream consumers can still satisfy their own promises;
- identify hidden coupling, invariant violations, and compatibility hazards;
- issue PASS, FAIL, or BLOCKED within Architecture authority.

### Prohibited actions

- treat successful compilation or QA PASS as proof of semantic compatibility;
- replace UAT/Product judgment about whether the feature solves the intended user outcome;
- implement fixes while acting as Architect;
- approve a revision without sufficient consumer/dependency context;
- approve an unspecified or superseded revision.

### Output

An Architecture review result must be representable as structured data with:

- role = Architect;
- task ID;
- exact revision identity;
- outcome = PASS | FAIL | BLOCKED;
- affected contracts/modules;
- dependency/consumer surfaces inspected;
- semantic compatibility assessment;
- invariant/dependency-rule assessment;
- findings and evidence references;
- remediation required for non-PASS results.

### Authority

The Architect alone may issue the **Architecture judgment** for the exact revision. An Architecture FAIL is valid even when types compile and QA passes.

## 6. UAT / Product Reviewer

### Purpose

Determine whether the exact revision achieves the original intended user/system outcome in realistic use, not merely whether implementation-level behavior is internally correct.

### Authorized inputs / context

UAT/Product should receive:

- original objective and intended outcome;
- acceptance scenarios and user/system-facing behavior;
- exact revision being evaluated;
- enough operational/system context to exercise the intended behavior;
- relevant QA and Architecture results as evidence where helpful.

Implementation detail should be minimized unless needed to exercise or diagnose the user/system outcome.

### Allowed actions

- exercise realistic end-to-end or outcome-focused scenarios;
- compare delivered behavior to the original objective;
- detect "technically correct but wrong outcome" implementations;
- issue PASS, FAIL, or BLOCKED within UAT/Product authority;
- record scenario-based findings and missing outcomes.

### Prohibited actions

- substitute code-style, unit-test, or architecture opinion for intended-outcome judgment;
- waive the original objective because implementation matches an internal design;
- implement fixes while acting as UAT/Product;
- approve an unspecified or superseded revision.

### Output

A UAT/Product result must be representable as structured data with:

- role = UAT/Product;
- task ID;
- exact revision identity;
- outcome = PASS | FAIL | BLOCKED;
- intended outcomes/scenarios exercised;
- observed user/system behavior;
- evidence references;
- findings;
- remediation required for non-PASS results.

### Authority

UAT/Product alone may issue the **intended-outcome judgment** for the exact revision. It does not determine merge readiness.

## 7. Merge Controller

### Purpose

Enforce merge policy using recorded facts and required evidence. The Merge Controller performs no implementation judgment and does not reinterpret requirements.

### Authorized inputs / context

The Merge Controller should receive only merge-readiness facts, including:

- task ID and canonical branch identity;
- exact PR head/revision identity;
- required deterministic validation status;
- required QA, Architecture, and UAT/Product results for that same revision;
- unresolved blocking findings;
- dependency/task-state facts required by policy;
- CI/branch-protection status;
- any explicitly required human gate.

It does not require broad implementation reasoning context.

### Allowed actions

- verify required evidence exists and applies to the exact PR head;
- reject stale approvals when the head revision moved;
- compute/report merge readiness according to policy;
- merge only when every required policy fact is satisfied;
- otherwise issue BLOCKED/NOT READY facts with missing prerequisites.

### Prohibited actions

- override failed or missing reviews by personal judgment;
- reinterpret acceptance criteria;
- perform QA, Architecture, or UAT approval;
- merge a revision different from the approved exact head;
- treat a role narrative as equivalent to recorded evidence;
- declare a task DONE solely because a PR merged; the later lifecycle controller owns authoritative completion transition.

### Output

A Merge Controller result must be representable as structured data with:

- role = MergeController;
- task ID;
- exact PR head/revision identity;
- readiness outcome;
- policy checks evaluated;
- evidence/review references;
- blocking prerequisites, if any;
- merge action/result when authorized.

### Authority

The Merge Controller alone owns the **merge-policy decision**. It has no authority to replace implementation or review judgments.

## 8. Lifecycle gate authority matrix

| Lifecycle concern / gate | Role authorized to issue judgment | What that judgment means |
| --- | --- | --- |
| Implementation prepared for handoff | Developer | The assigned change has been implemented and developer validation evidence is ready. Not an independent approval. |
| QA review | QA Reviewer | The exact revision satisfies behavior, acceptance criteria, negative/edge cases, and regression expectations. |
| Architecture review | Architecture Reviewer | The exact revision satisfies semantic producer/consumer compatibility, dependency rules, and architectural invariants. |
| UAT / Product review | UAT/Product Reviewer | The exact revision achieves the original intended user/system outcome in realistic scenarios. |
| Merge readiness | Merge Controller | Required evidence and policy are satisfied for the exact PR head. No requirement reinterpretation occurs here. |
| Authoritative lifecycle transition | Future deterministic workflow engine | Role outputs are evidence; repository-native code later owns state transition authority. |

No role may borrow another role's authority because the same person/model is capable of reasoning from multiple perspectives.

## 9. Required scenario rules

### Scenario A — Developer attempts self-approval

A Developer implements revision `R1`, runs tests, then declares "QA PASS" or "Architecture PASS."

**Result:** prohibited. The self-check may be recorded only as Developer evidence. Independent QA/Architecture judgment is still missing.

### Scenario B — Same model performs another role

The same underlying model that implemented `R1` is later invoked as QA.

**Result:** permitted only as a fresh QA role session with QA-specific context, no reliance on hidden conversation state, and an independently recorded QA result. The original Developer session may not simply relabel itself as QA.

### Scenario C — PR head moves after review

QA, Architecture, and UAT approve revision `R1`. A new commit creates revision `R2`.

**Result:** the prior approvals are not automatically valid for `R2`. Later invalidation policy decides which reviews must rerun, but the Merge Controller must never treat `R1` approvals as approval of `R2` without explicit valid evidence.

### Scenario D — Local tests pass but consumer semantics break

A provider still returns the same type and QA verifies its local acceptance criteria, but the implementation narrows a value range required by a downstream consumer.

**Result:** Architecture FAIL is authorized even if QA PASS and compilation succeed.

### Scenario E — Correct implementation misses intended outcome

QA and Architecture pass, but realistic UAT shows the feature does not accomplish the original user/system objective.

**Result:** UAT/Product FAIL. Merge readiness is blocked.

### Scenario F — All reviews pass but evidence targets old head

Required review results exist, but the PR head differs from their revision identity.

**Result:** Merge Controller must report not ready/blocked. It may not merge based on stale evidence.

## 10. Boundary to later BOOT tasks

This document intentionally stops at role definition.

Later tasks own:

- machine-readable schemas and schema versioning (BOOT-003);
- role-aware context compilation (BOOT-012);
- validation/evidence storage (BOOT-014 through BOOT-016);
- executable review workflows and structured findings machinery (BOOT-017 through BOOT-021);
- PR integration, CI enforcement, merge policy, and controlled completion (BOOT-022 through BOOT-025);
- agent runner/provider adapters and orchestration (BOOT-026 onward).

Those implementations must preserve these authority boundaries unless an explicit reviewed constitutional change says otherwise.
