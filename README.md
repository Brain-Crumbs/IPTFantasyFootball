# IPTFantasyFootball

Fantasy Football runs its development workflow through the pinned [Vibez package](https://github.com/Brain-Crumbs/Vibez/releases/tag/v0.1.0-rc.2). This repository owns the project configuration, requirements, task definitions, project contracts and installed-consumer checks. Reusable workflow implementation is maintained in [Vibez](https://github.com/Brain-Crumbs/Vibez).

Use a dedicated checkout on a [supported platform](docs/VIBEZ_CUTOVER.md). Install with `npm ci --engine-strict` and run `npm run --silent agent -- --json status`. The [cutover guide](docs/VIBEZ_CUTOVER.md) describes the authorized operator workflow, history inspection and stopped-writer rollback. See [CI](docs/CI.md) for the required checks.

[AGENTS.md](AGENTS.md), [CONSTITUTION.md](CONSTITUTION.md) and [BOOTSTRAP.md](BOOTSTRAP.md) govern implementation and review. The bootstrap [master issue](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/1), [migration epic](https://github.com/Brain-Crumbs/IPTFantasyFootball/issues/74) and [Vibez roadmap](https://github.com/Brain-Crumbs/Vibez/issues/1) retain their distinct scope.

The last adoption revision retains the [embedded source and historical docs](https://github.com/Brain-Crumbs/IPTFantasyFootball/tree/c7fa639539d2f92a36a59a1bb2fd4630d7fbd7d2). For the retired canary and stopped migration runs, use the verified archives with their matching readers.
