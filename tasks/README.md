# Project tasks

The installed Fantasy Football host loads committed `*.task.json` records
from [`tasks/admitted/`](admitted). Topic and dependency checks use the
installed package schemas. Follow the [reviewed admission process](../migration/README.md)
before authorizing a run. The [cutover guide](../docs/VIBEZ_CUTOVER.md)
describes the scoped MIG-010 entry point.

- `tasks/archive/` preserves the retired CANARY-001 definition and its original identity.
- `tasks/definitions/` is the bootstrap reader's historical discovery path.
- `migration/tasks/` holds staged planning definitions, including external prerequisite edges in the accompanying plan.

Under current bootstrap governance, GitHub issues establish assignment
authority. A read-only selection does not assign or start a task. Keep
lifecycle records and historical evidence in their original stores.
