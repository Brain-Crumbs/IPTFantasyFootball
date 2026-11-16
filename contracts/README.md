# contracts/

Fantasy Football keeps project-owned semantic contracts in `contracts/project/`. Vibez owns the reusable engine contracts and publishes them through its [assets API](https://github.com/Brain-Crumbs/Vibez/blob/v0.1.0-rc.2/docs/PUBLIC_API.md). The pinned [adoption tree](https://github.com/Brain-Crumbs/IPTFantasyFootball/tree/c7fa639539d2f92a36a59a1bb2fd4630d7fbd7d2/contracts) preserves the original views.

BOOT-004 defines the standard bundle:

- `STANDARD.md` — normative human-readable contract requirements and review guidance.
- `MODULE_README_TEMPLATE.md` — reusable Markdown template for a module's human-readable contract.
- `examples/range-provider/` — complete example showing how unchanged public types can still create a semantic downstream break.
- the installed `module-contract.schema.json` — authoritative machine-readable v1 manifest schema.

## Required bundle for future modules

Each module/provider/adapter that exposes a reusable capability must keep two adjacent views of the same contract:

1. a human-readable module README using the required sections in `MODULE_README_TEMPLATE.md`; and
2. a machine-readable manifest validated by the installed module-contract schema.

The Markdown and manifest must agree. A discrepancy is a contract defect and must be surfaced rather than silently reconciled.

BOOT-004 defines the representation standard only. Architecture-review automation, CI dependency enforcement, and fantasy-football product modules are intentionally deferred to later tasks.
