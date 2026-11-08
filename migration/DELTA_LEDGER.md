# Source-delta ledger and ownership handoff

Baseline source: FF `fbc46888ce0bd2af454f471561911a913d32e6fc`. This is an initial tracking ledger, not an assertion that a destination export or release exists.

| Item | Source owner | Import / verification owner | Current disposition |
| --- | --- | --- | --- |
| UAT context fix #76 | FF #76, canonical bootstrap/boot-036-uat-context-repair | MIG-003 verifies exact accepted fix commit/paths and contract-bearing UAT regression; MIG-006 verifies installed behavior | Issue is closed, but inspected main has no integrated fix commit; PR #77 changed only canary guidance. Acceptance/import unresolved; do not claim the fix is present. |
| General manual driver #78 / BOOT-037 | FF #78, canonical bootstrap/boot-037-general-workflow-driver | MIG-002 agrees config seams; MIG-003 tracks provenance; MIG-006 imports once and verifies full acceptance | Open; blocks MIG-006 complete-driver acceptance |
| Planning/application service/supervision #75 | FF #75 until extraction ownership is reconciled | MIG-002 API/config contract; AUT-003 composes shared supervisor | Open; HTTP/UI not an extraction prerequisite |
| MIG-001 governance and registration | FF #80 | MIG-002/003 retain accepted decisions and adapt destination governance | Candidate; acceptance is the final PR/review/CI evidence |
| Necessary reusable source bug fixes after baseline | Owning FF issue until final checkpoint | MIG-003 delta inventory; MIG-008 final reconciliation | Record each exact delta before importing |

For every new source delta, append source issue/PR, source commit and affected path/blob hashes, reason for the source exception, destination issue/PR/commit, transformed-path hashes, compatibility/review/validation evidence, and disposition (pending/imported/excluded with accepted rationale). Do not mark imported from issue closure, and do not import it twice. MIG-002 defines the complete inventory and final ledger format; MIG-003 implements the reproducible comparison.

MIG-008 owns the final synchronization checkpoint: every accepted reusable delta, #76 and #78 accounted for; destination SHA and package checksum recorded; no unresolved parity gaps. After that checkpoint reusable changes land in Vibez, and FF receives pinned dependency updates. MIG-009 proves adoption and rollback during its explicit observation window; MIG-010 alone removes the reviewed duplicate paths. Never run two authoritative engines against one state store.

Ledger corrections retain earlier evidence and explain supersession. They do not rewrite historical approvals or authorize active-run upgrades.
