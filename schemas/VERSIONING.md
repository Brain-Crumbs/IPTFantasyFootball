# Schema versioning policy

Every record carries a stable `schemaId` and semantic `schemaVersion` in `MAJOR.MINOR.PATCH` form. Schema definitions are grouped by supported major version under `schemas/v<MAJOR>/`.

## Compatibility

- **Patch:** clarification or metadata/example change that does not alter which records are valid or what existing fields mean.
- **Minor:** backward-compatible extension, such as adding an optional field. It must not invalidate a previously valid record or silently change an existing field's meaning.
- **Major:** breaking change, including removing/renaming fields, making optional fields required, narrowing enums/ranges, changing identity conventions, or changing field semantics.

A behavioral/range change can be a semantic breaking change for a consumer even if structural JSON shape is unchanged. Module/consumer contract metadata exists so Architecture review can see those expectations.

## Reader behavior

1. Resolve records by exact `schemaId`.
2. Parse `schemaVersion`.
3. Reject missing, malformed, or unsupported major versions deterministically; never coerce, infer, or silently fall back.
4. Within a supported major, accept minor/patch versions only when the reader explicitly declares support for them.
5. Keep human documentation and machine schemas synchronized when terminology or semantics change.

`fixtures/v1/task.unknown-major.json` demonstrates required rejection of unsupported major version 2 by the v1 task schema.
