#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "./core.js";
import { EXIT_CODES, OUTPUT_SCHEMA_VERSION } from "./contracts.js";

async function main(): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const args = process.argv.slice(2);
  const [command, operation] = args.filter((arg) => arg !== "--json");
  const legacyWrite = command !== undefined && operation !== undefined && (
    ["start", "validate", "manual", "orchestrate"].includes(command)
    || (command === "recovery" && operation === "apply")
  );
  if (legacyWrite && existsSync(resolve(process.cwd(), "vibez.config.json"))) {
    const message = "Embedded workflow writes are disabled for configured Vibez projects. Use npm run agent.";
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: OUTPUT_SCHEMA_VERSION,
        ok: false,
        command,
        data: null,
        error: { code: "LEGACY_WRITER_DISABLED", message },
      })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return EXIT_CODES.WORKFLOW_BLOCKED;
  }
  const manualRun = args.filter((arg) => arg !== "--json").slice(0, 2).join(" ") === "manual run" || args.filter(arg => arg !== "--json")[0] === "orchestrate";
  if (manualRun) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
  }
  try {
    const result = await runCli(args, { signal: controller.signal, driverRuntime: {progress:message=>process.stderr.write(`${message}\n`)} });

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
  } finally {
    if (manualRun) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

process.exitCode = await main();
