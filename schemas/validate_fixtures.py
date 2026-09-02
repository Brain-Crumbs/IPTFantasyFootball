#!/usr/bin/env python3
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent
SCHEMA_DIR = ROOT / "v1"
FIXTURE_DIR = ROOT / "fixtures" / "v1"
FAMILIES = ["task","requirement","lifecycle-state","assignment-lock","validation-evidence","review-result","module-contract"]
failures = []

for family in FAMILIES:
    schema = json.loads((SCHEMA_DIR / f"{family}.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    for expectation in ("valid", "invalid"):
        path = FIXTURE_DIR / f"{family}.{expectation}.json"
        instance = json.loads(path.read_text())
        errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
        if expectation == "valid" and errors:
            failures.append(f"{path}: expected valid, got {errors[0].message}")
        if expectation == "invalid" and not errors:
            failures.append(f"{path}: expected invalid, but validation succeeded")

task_schema = json.loads((SCHEMA_DIR / "task.schema.json").read_text())
unknown = json.loads((FIXTURE_DIR / "task.unknown-major.json").read_text())
if not list(Draft202012Validator(task_schema).iter_errors(unknown)):
    failures.append("task.unknown-major.json: unsupported major version was accepted")

review_schema = json.loads((SCHEMA_DIR / "review-result.schema.json").read_text())
review_validator = Draft202012Validator(review_schema, format_checker=FormatChecker())

nonpass = json.loads((FIXTURE_DIR / "review-result.nonpass-invalid.json").read_text())
if not list(review_validator.iter_errors(nonpass)):
    failures.append("review-result.nonpass-invalid.json: non-PASS result without remediation was accepted")

role_samples = json.loads((FIXTURE_DIR / "review-result.roles-valid.json").read_text())
for index, sample in enumerate(role_samples):
    errors = list(review_validator.iter_errors(sample))
    if errors:
        failures.append(f"review-result.roles-valid.json[{index}]: expected valid, got {errors[0].message}")

if failures:
    for failure in failures:
        print(f"FAIL: {failure}")
    raise SystemExit(1)

print("PASS: valid fixtures accepted; invalid fixtures and unknown major rejected")
