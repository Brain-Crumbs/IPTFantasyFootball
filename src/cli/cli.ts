#!/usr/bin/env node

import { runCli } from "./core.js";
import { EXIT_CODES, OUTPUT_SCHEMA_VERSION } from "./contracts.js";

function main(): number {
  try {
    const result = runCli(process.argv.slice(2));

    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }

    return result.exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown internal error.";
    if (process.argv.slice(2).includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        ok: false,
        command: "internal",
        data: null,
        error: { code: "INTERNAL_ERROR", message },
      })}\n`);
    } else {
      process.stderr.write(`INTERNAL_ERROR: ${message}\n`);
    }
    return EXIT_CODES.INTERNAL_ERROR;
  }
}

process.exitCode = main();
