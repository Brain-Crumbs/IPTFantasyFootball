# Consumer validation and CI

The exact-head policy in `vibez.config.json` requires four checks on the GitHub pull request. The existing names are retained across the removal so the same installed readiness controller can validate both revisions.

| Check | What it verifies |
| --- | --- |
| Build and test (Node) | Installs the lockfile, checks tracked source ownership, task registry, staged migration provenance, admission and bundled contracts, and runs the consumer tests. |
| Schema and contract validation (Python) | Validates the authored project and historical records with the published Vibez schemas loaded from the public assets API. |
| Installed consumer (Ubuntu) | Installs from the exact pin on Ubuntu 24.04 with Node 22 and exercises the supported consumer entry point. |
| Installed consumer (Windows) | Installs from the exact pin on Windows Server 2025 with Node 24 and exercises local NTFS attestation and the same entry point. |

Run `npm ci --engine-strict`, `npm run build` and `npm test` locally. With Python 3.11 and `jsonschema>=4.23,<5` installed, run `python scripts/validate-consumer-records.py`. The check names are also the required statuses for the controlled merge. Provisioning and protection settings remain GitHub administration.

The embedded engine's regression checks and archived records can be inspected in the [last adoption revision](https://github.com/Brain-Crumbs/IPTFantasyFootball/tree/c7fa639539d2f92a36a59a1bb2fd4630d7fbd7d2). Reusable engine regression and release tests now live in [Vibez](https://github.com/Brain-Crumbs/Vibez).
