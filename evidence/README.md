# evidence/

> Historical Fantasy Football workflow record. For current installed operations see the [Vibez cutover guide](../docs/VIBEZ_CUTOVER.md).

Documentation home for `control-plane.evidence-store` (BOOT-015 / issue #17), the deterministic validation and review evidence persistence boundary defined in [contracts/evidence-store/README.md](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/c7fa639539d2f92a36a59a1bb2fd4630d7fbd7d2/contracts/evidence-store/README.md) and [contracts/evidence-store/module-contract.json](https://github.com/Brain-Crumbs/IPTFantasyFootball/blob/c7fa639539d2f92a36a59a1bb2fd4630d7fbd7d2/contracts/evidence-store/module-contract.json).

BOOT-015 binds evidence to task ID, run/role, exact commit/revision identity, schema version, and timestamps; validates every record against `schemas/v1/validation-evidence.schema.json` or `schemas/v1/review-result.schema.json` before acceptance; and never overwrites a prior record. It does not execute validators or reviews and does not decide merge readiness — those remain owned by BOOT-016 and the later review tasks.

This directory intentionally holds no runtime evidence data itself. The local, ignored `.agent/state/` composition (the same boundary BOOT-013 uses for lifecycle/lock state) is where an `agent`-driven workflow will persist actual `FileEvidenceStore` records once a later BOOT task (BOOT-016 onward) wires evidence capture into a live command; see `contracts/evidence-store/README.md` for the exact on-disk layout used by `FileEvidenceStore` itself.
