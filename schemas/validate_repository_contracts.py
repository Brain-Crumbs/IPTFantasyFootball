#!/usr/bin/env python3
"""Repository invariant: every real contract/task record must validate against its schema.

This is distinct from schemas/validate_fixtures.py, which only proves the *schema
definitions* accept/reject their own hand-written valid/invalid fixtures. This
script instead walks the repository's actual authored records --
contracts/**/module-contract.json and tasks/definitions/*.task.json -- and
validates each one against the corresponding schemas/v1/*.schema.json document,
so a malformed real record fails CI instead of only being caught by chance in a
future consumer.
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "schemas" / "v1"

RECORD_FAMILIES = [
    {
        "label": "module-contract",
        "schema": SCHEMA_DIR / "module-contract.schema.json",
        "glob": "contracts/**/module-contract.json",
        "require_at_least_one": True,
    },
    {
        "label": "task",
        "schema": SCHEMA_DIR / "task.schema.json",
        "glob": "tasks/definitions/*.task.json",
        "require_at_least_one": False,
    },
]

failures = []
total_checked = 0

for family in RECORD_FAMILIES:
    schema = json.loads(family["schema"].read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)

    matches = sorted(ROOT.glob(family["glob"]))
    if family["require_at_least_one"] and not matches:
        failures.append(
            f"{family['label']}: expected at least one file matching {family['glob']!r}, found none "
            "(glob pattern may be stale)"
        )
        continue

    for path in matches:
        total_checked += 1
        relative = path.relative_to(ROOT)
        try:
            instance = json.loads(path.read_text())
        except json.JSONDecodeError as error:
            failures.append(f"{relative}: invalid JSON ({error})")
            continue

        errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
        if errors:
            failures.append(f"{relative}: {errors[0].message} (at {list(errors[0].absolute_path)})")

if failures:
    for failure in failures:
        print(f"FAIL: {failure}")
    raise SystemExit(1)

print(f"PASS: {total_checked} repository contract/task record(s) validated against their schema")
