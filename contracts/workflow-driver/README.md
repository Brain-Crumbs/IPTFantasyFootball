# Workflow driver

BOOT-037 composes the existing manual adapter, orchestration engine, registry,
diagnostics/recovery, PR lifecycle and controlled merge. The CLI shell routes
commands and envelopes; the driver has no lifecycle or evidence write port of
its own. See [the operator guide](../../docs/WORKFLOW_DRIVER.md) for the supported
workflow and rollback.

The driver owns v1 profile, intake, session, diagnostic, response, and receipt
records. It retains immutable role packets and publishes a separate copy-ready
companion. Profile and project hashes bind durable coordination state. One
writer per scan/advance keeps local mutations serialized; a second watcher does
not steal tokens. Registration requires a committed task at the checked source.

`prepareAgentInput` is a non-dispatching host hook: false reports `WAITING_INPUT`
before counting any provider attempt. When true, the runner still validates
the immutable result. BOOT-037 uses this hook to accept a Developer's original
invocation result at the actual descendant HEAD and stops terminal non-PASS
Developer outcomes before validation. Default engine consumers retain their
prior behavior. A linked successor names the original run and key; it must
reconcile an existing assignment and use the owning rework transition first.
The source fence is checked by the developer validation gate before durable
writes, and the default validator environment is unchanged for other consumers.
When QA is not declared, the driver asks the validation gate to enter the
first declared Architecture or UAT gate (or MERGE_READY if no independent
review is required) in the same checked state write. The normal validation
event and evidence remain distinct from review entry; neither claims a review
judgment. Callers that omit the option still stop at DEV_VALIDATED.

The PR adapter and controller remain authoritative. The driver checks source,
remote, issue, branch/base and head before publication. A scoped host grant and
an exact SHA are required before a merge write; native reconciliation of an
already confirmed merge is read-only at GitHub and restricted to the durable
exact PR authorization intent. Setup, diagnostic responses,
receipt records, and issue Markdown cannot supply publication/merge authority.
