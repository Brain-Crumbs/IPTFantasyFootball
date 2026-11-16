"""Validate the consumer's authored documents using the pinned Vibez schemas."""
import json
import subprocess
from pathlib import Path

from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parent.parent
FAMILIES = {
    "module-contract": ("contracts/**/module-contract.json",),
    "task": ("tasks/**/*.task.json", "migration/tasks/*.task.json"),
    "requirement": ("requirements/**/*.requirement.json",),
}


def load_schema_documents():
    program = """
        import { getAssetCatalog, readSchema } from '@brain-crumbs/vibez/assets';
        const names = ['module-contract', 'task', 'requirement'];
        const sources = getAssetCatalog().schemas;
        const records = names.map(name => {
          const schema = sources.find(({ path }) => path.endsWith('/' + name + '.schema.json'));
          return [name, readSchema(schema.id).document];
        });
        console.log(JSON.stringify(Object.fromEntries(records)));
    """
    return json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", program], cwd=ROOT, encoding="utf-8"
    ))


def main():
    schemas = load_schema_documents()
    count = 0
    for name, patterns in FAMILIES.items():
        schema = schemas[name]
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        paths = sorted({path for pattern in patterns for path in ROOT.glob(pattern)})
        if not paths:
            raise SystemExit(f"{name}: no consumer records found")
        for path in paths:
            try:
                validator.validate(json.loads(path.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, ValidationError) as error:
                raise SystemExit(f"{path.relative_to(ROOT)}: {error.message if isinstance(error, ValidationError) else error.msg}") from error
            count += 1
    print(f"PASS: {count} consumer records validated against the installed Vibez schemas")


if __name__ == "__main__":
    main()
