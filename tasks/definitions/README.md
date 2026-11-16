# Historical bootstrap task discovery

BOOT-006 used this directory for `*.task.json` discovery. The Fantasy Football
consumer now selects its reviewed registry from [`tasks/admitted/`](../admitted).
The retired [CANARY-001 definition](../archive/canary-001.task.json) is
preserved in the archive. Original canary history remains with the pinned
bootstrap checkout and reader described in the [cutover guide](../../docs/VIBEZ_CUTOVER.md).

Use [reviewed admission](../../migration/README.md) for new work.
