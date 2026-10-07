import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AGENT_RUNNER_ROLES, AgentProviderError, type AgentProvider, type AgentProviderCapabilities, type AgentProviderErrorCode, type AgentRunRequest, type AgentRunResult, type AgentToolPermissionPolicy } from "../agent-provider/index.js";
import type { ContextPackage } from "../context-compiler/index.js";
import { canonicalJson, deepFreeze, MAX_LOCAL_AGENT_JSON_BYTES } from "./json.js";
import { assertSupportedSchema, schemaErrors } from "./schema.js";

export const LOCAL_MANUAL_PROVIDER_ID = "local-manual-agent" as const;
const PACKET_ID = /^[a-f0-9]{64}$/;
const MAX_TIMEOUT_MS = 2147483647;

export interface LocalAgentBinding {
  readonly packetId: string;
  readonly providerId: typeof LOCAL_MANUAL_PROVIDER_ID;
  readonly taskId: string;
  readonly role: AgentRunRequest["role"];
  readonly revisionIdentity: string;
  readonly runId: string;
  readonly actorId: string;
  readonly contextIdentity: string;
  readonly inputIdentity: string;
}
export interface LocalAgentPacket extends LocalAgentBinding {
  readonly schemaId: "ipt.local-agent-packet";
  readonly schemaVersion: "1.0.0";
  readonly contextPackage: ContextPackage;
  readonly toolPermissionPolicy: AgentToolPermissionPolicy;
  readonly resultBinding: LocalAgentBinding;
  readonly instructions: readonly string[];
}
export type LocalAgentResult = LocalAgentBinding & {
  readonly schemaId: "ipt.local-agent-result";
  readonly schemaVersion: "1.0.0";
} & (
  | { readonly status: "COMPLETED"; readonly result: AgentRunResult }
  | { readonly status: "CANCELLED"; readonly error: { readonly message: string } }
  | { readonly status: "ERROR"; readonly error: { readonly message: string; readonly recoverable: false } }
);
export interface LocalAgentImportResult {
  readonly result: LocalAgentResult;
  readonly resultPath: string;
  readonly reused: boolean;
}
export interface FileManualAgentProviderOptions {
  readonly repositoryRoot?: string;
  readonly pollIntervalMs?: number;
}

const INSTRUCTIONS = Object.freeze([
  "Open this packet in a fresh external session for only its named role and actor. Use the complete contextPackage as supplied; do not add another role's private narrative.",
  "The operator must enforce toolPermissionPolicy in the external session. This file adapter cannot sandbox or stop external tools, processes, or agents.",
  "Start from the packet task and exact revision within its declared scope. Developer may implement and commit a new revision, but must retain the original invocation revision in the result binding; deterministic validation resolves actual HEAD afterward. Reviewers must not modify source or HEAD. Do not edit lifecycle state, forge evidence, approve your own implementation, or merge.",
  "Create a JSON response by copying resultBinding unchanged and adding schemaId: ipt.local-agent-result, schemaVersion: 1.0.0, and status: COMPLETED, CANCELLED, or ERROR. See schemas/v1/local-agent-result.schema.json.",
  "For COMPLETED add result with runId, providerId, taskId, role, revisionIdentity copied from the binding; supply outcome PASS/FAIL/BLOCKED, role-appropriate details, findings, evidenceRefs and occurredAt (RFC3339). FAIL/BLOCKED also require nonPass.reason and nonPass.remediation. A completed FAIL/BLOCKED is a semantic judgment, not an execution error.",
  "For CANCELLED add error: {message: your explanation}. For ERROR add error: {message: your explanation, recoverable: false}. These are terminal external outcomes; a changed judgment requires a new run identity.",
  "Import using agent manual import <packet-id> <result-file> <exchange-dir>. The waiting agent manual run <request-file> <exchange-dir> receives the result; exporting and importing alone never advance workflow state.",
  "Keep the packet and published result unchanged. Exact retries reuse them; changed context, policy, binding, or result conflicts are rejected. A local cancellation/timeout only stops waiting, so stop external work separately if needed.",
]);

/** An exchange-file adapter only: it owns no lifecycle, evidence or merge authority. */
export class FileManualAgentProvider implements AgentProvider {
  readonly providerId = LOCAL_MANUAL_PROVIDER_ID;
  readonly #root: string;
  readonly #pollIntervalMs: number;
  readonly #packetSchema: Record<string, unknown>;
  readonly #resultSchema: Record<string, unknown>;

  constructor(root: string, options: FileManualAgentProviderOptions = {}) {
    if (typeof root !== "string" || !root.trim()) throw error("INVALID_REQUEST", "Exchange directory must be non-empty.");
    const poll = options.pollIntervalMs ?? 250;
    if (!Number.isInteger(poll) || poll < 1 || poll > 60000) throw error("INVALID_REQUEST", "pollIntervalMs must be an integer between 1 and 60000.");
    this.#root = resolve(root);
    this.#pollIntervalMs = poll;
    const repositoryRoot = options.repositoryRoot ?? process.cwd();
    this.#packetSchema = loadSchema(join(repositoryRoot, "schemas/v1/local-agent-packet.schema.json"));
    this.#resultSchema = loadSchema(join(repositoryRoot, "schemas/v1/local-agent-result.schema.json"));
    this.#ensureDirectory();
  }

  capabilities(): AgentProviderCapabilities {
    return Object.freeze({ providerId: this.providerId, supportedRoles: AGENT_RUNNER_ROLES, supportsCancellation: true, supportsTimeout: true });
  }

  packetPath(packetId: string): string { return this.#path(packetId, "packet"); }
  resultPath(packetId: string): string { return this.#path(packetId, "result"); }

  exportPacket(request: AgentRunRequest): LocalAgentPacket {
    validateControls(request);
    let packet: LocalAgentPacket;
    try {
      // Serialize only the port's durable inputs. Signal/timeout are local wait
      // controls, deliberately excluded so cancellation can resume the same packet.
      const inputs = JSON.parse(canonicalJson({ taskId: request.taskId, role: request.role, revisionIdentity: request.revisionIdentity, runId: request.runId, actorId: request.actorId, contextPackage: request.contextPackage, toolPermissionPolicy: request.toolPermissionPolicy })) as AgentRunRequest;
      const contextIdentity = hash(inputs.contextPackage);
      const inputIdentity = hash({ contextPackage: inputs.contextPackage, toolPermissionPolicy: inputs.toolPermissionPolicy });
      const binding: LocalAgentBinding = { ...identity(inputs), packetId: hash(identity(inputs)), contextIdentity, inputIdentity };
      packet = { schemaId: "ipt.local-agent-packet", schemaVersion: "1.0.0", ...binding, contextPackage: inputs.contextPackage, toolPermissionPolicy: inputs.toolPermissionPolicy, resultBinding: binding, instructions: INSTRUCTIONS };
      this.#validatePacket(packet, "INVALID_REQUEST");
    } catch (cause: unknown) { throw normalize(cause, "INVALID_REQUEST", false); }
    const path = this.packetPath(packet.packetId);
    const reused = this.#publish(path, packet);
    if (reused) {
      const stored = this.readPacket(packet.packetId);
      if (canonicalJson(stored) !== canonicalJson(packet)) throw error("INVALID_REQUEST", "This request identity already has a different context or tool policy. Use a new run identity; existing packets/results cannot be replaced.");
      return stored;
    }
    return deepFreeze(packet);
  }

  readPacket(packetId: string): LocalAgentPacket {
    const raw = this.#read(this.packetPath(packetId));
    if (raw === null) throw error("INVALID_REQUEST", `No exported packet exists for '${packetId}'.`);
    this.#validatePacket(raw, "MALFORMED_RESULT");
    const packet = raw as LocalAgentPacket;
    if (packet.packetId !== packetId) throw error("MALFORMED_RESULT", "Packet filename does not match packet identity.");
    return deepFreeze(packet);
  }

  importResult(packetId: string, payload: unknown): LocalAgentImportResult {
    const packet = this.readPacket(packetId);
    const result = this.#validateResult(payload, packet);
    const path = this.resultPath(packetId);
    const reused = this.#publish(path, result);
    if (reused) {
      const stored = this.#readResult(packet);
      if (stored === null || canonicalJson(stored) !== canonicalJson(result)) throw error("MALFORMED_RESULT", "A different immutable result is already published for this packet; use a new run identity.");
    }
    return Object.freeze({ result, resultPath: path, reused });
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    validateControls(request);
    if (request.signal?.aborted) throw cancelled();
    const started = performance.now();
    const packet = this.exportPacket(request);
    while (true) {
      if (request.signal?.aborted) throw cancelled();
      if (request.timeoutMs !== undefined && performance.now() - started >= request.timeoutMs) throw error("TIMEOUT", "Local manual result wait timed out; external work has not been stopped.", true);
      const imported = this.#readResult(packet);
      if (imported !== null) {
        if (imported.status === "CANCELLED") throw error("CANCELLED", imported.error.message);
        if (imported.status === "ERROR") throw error("PROVIDER_ERROR", imported.error.message);
        return imported.result;
      }
      // Missing input is pending, never an infrastructure failure/retry attempt.
      const remaining = request.timeoutMs === undefined ? this.#pollIntervalMs : Math.max(1, request.timeoutMs - (performance.now() - started));
      await wait(Math.min(this.#pollIntervalMs, remaining), request.signal);
    }
  }

  #validatePacket(value: unknown, code: AgentProviderErrorCode): void {
    try {
      canonicalJson(value);
      const errors = schemaErrors(value, this.#packetSchema);
      if (errors.length) throw new Error(`Invalid packet: ${errors.slice(0, 5).join("; ")}`);
      const packet = value as LocalAgentPacket;
      if (packet.contextPackage.taskId !== packet.taskId || packet.contextPackage.role !== packet.role || packet.contextPackage.sourceRevision !== packet.revisionIdentity) throw new Error("Compiled context does not match task/role/revision.");
      if (packet.contextIdentity !== hash(packet.contextPackage) || packet.inputIdentity !== hash({ contextPackage: packet.contextPackage, toolPermissionPolicy: packet.toolPermissionPolicy }) || packet.packetId !== hash(identity(packet))) throw new Error("Packet content/identity hash does not match.");
      if (canonicalJson(packet.resultBinding) !== canonicalJson(bindingFrom(packet))) throw new Error("Packet result binding does not match.");
      if (canonicalJson(packet.instructions) !== canonicalJson(INSTRUCTIONS)) throw new Error("Packet handoff instructions were changed.");
    } catch (cause: unknown) { throw normalize(cause, code, false); }
  }

  #validateResult(payload: unknown, packet: LocalAgentPacket): LocalAgentResult {
    try {
      const copy: unknown = JSON.parse(canonicalJson(payload));
      const errors = schemaErrors(copy, this.#resultSchema);
      if (errors.length) throw new Error(`Invalid result: ${errors.slice(0, 5).join("; ")}`);
      const result = copy as LocalAgentResult;
      if (canonicalJson(bindingFrom(result)) !== canonicalJson(packet.resultBinding)) throw new Error("Result binding does not match task/role/run/actor/revision/context/policy packet identity.");
      if (result.status === "COMPLETED") {
        for (const key of ["providerId", "taskId", "role", "revisionIdentity", "runId"] as const) {
          if (result.result[key] !== packet[key]) throw new Error(`Agent result ${key} does not match packet.`);
        }
        const ids = result.result.findings.map(f => f.findingId);
        if (new Set(ids).size !== ids.length) throw new Error("Result finding IDs must be unique.");
      }
      return deepFreeze(result);
    } catch (cause: unknown) { throw normalize(cause, "MALFORMED_RESULT", false); }
  }

  #readResult(packet: LocalAgentPacket): LocalAgentResult | null {
    // Re-read the immutable packet too: corruption after export must not let a
    // pending waiter silently consume a result bound to changed durable inputs.
    const stored = this.readPacket(packet.packetId);
    if (canonicalJson(stored) !== canonicalJson(packet)) throw error("MALFORMED_RESULT", "Exported packet changed while waiting.");
    const raw = this.#read(this.resultPath(packet.packetId));
    return raw === null ? null : this.#validateResult(raw, packet);
  }

  #path(packetId: string, kind: "packet" | "result"): string {
    if (typeof packetId !== "string" || !PACKET_ID.test(packetId)) throw error("INVALID_REQUEST", "packetId must be a lowercase SHA256 hex digest.");
    return join(this.#root, `${packetId}.${kind}.json`);
  }

  #ensureDirectory(): void {
    try {
      const chain: string[] = [];
      for (let current = this.#root; ; current = dirname(current)) { chain.push(current); if (dirname(current) === current) break; }
      for (const path of chain.reverse()) {
        try {
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw error("INVALID_REQUEST", "Exchange directory and its parents must be real directories, not symlinks.");
        } catch (cause: unknown) {
          if (!hasCode(cause, "ENOENT")) throw cause;
          try { mkdirSync(path, { mode: 0o700 }); } catch (mkdirError: unknown) { if (!hasCode(mkdirError, "EEXIST")) throw mkdirError; }
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw error("INVALID_REQUEST", "Exchange directory must be a real directory.");
        }
      }
    } catch (cause: unknown) { throw normalize(cause, "PROVIDER_ERROR", true); }
  }

  #read(path: string): unknown | null {
    this.#ensureDirectory();
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_LOCAL_AGENT_JSON_BYTES + 1) throw error("MALFORMED_RESULT", "Exchange record must be a regular file within the 4 MiB limit.");
      const text = readFileSync(fd, "utf8");
      if (new TextEncoder().encode(text).length > MAX_LOCAL_AGENT_JSON_BYTES + 1) throw error("MALFORMED_RESULT", "Exchange record exceeds 4 MiB.");
      try {
        const parsed: unknown = JSON.parse(text);
        // Only importer-generated canonical records are accepted. This also
        // rejects duplicate JSON keys, alternate encodings, and manual partial writes.
        if (text !== canonicalJson(parsed) + "\n") throw new Error("Record is not canonical JSON published by this adapter.");
        return parsed;
      } catch (cause: unknown) { throw normalize(cause, "MALFORMED_RESULT", false); }
    } catch (cause: unknown) {
      if (hasCode(cause, "ENOENT")) return null;
      if (hasCode(cause, "ELOOP")) throw error("MALFORMED_RESULT", "Exchange records must not be symlinks.");
      throw normalize(cause, "PROVIDER_ERROR", true);
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  #publish(path: string, value: unknown): boolean {
    this.#ensureDirectory();
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      const text = canonicalJson(value) + "\n";
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, text, { encoding: "utf8" });
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      try { linkSync(temporary, path); } catch (cause: unknown) { if (hasCode(cause, "EEXIST")) return true; throw cause; }
      // Atomic, no-overwrite publication: readers never see a partial file.
      const directoryFd = openSync(this.#root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return false;
    } catch (cause: unknown) { throw normalize(cause, "PROVIDER_ERROR", true); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* A crash may leave a harmless unpublished .tmp file. */ } }
  }
}

function identity(value: Pick<AgentRunRequest, "taskId" | "role" | "revisionIdentity" | "runId" | "actorId">) {
  return { providerId: LOCAL_MANUAL_PROVIDER_ID, taskId: value.taskId, role: value.role, revisionIdentity: value.revisionIdentity, runId: value.runId, actorId: value.actorId };
}
function bindingFrom(value: LocalAgentBinding): LocalAgentBinding {
  return { ...identity(value), packetId: value.packetId, contextIdentity: value.contextIdentity, inputIdentity: value.inputIdentity };
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function error(code: AgentProviderErrorCode, message: string, recoverable = false): AgentProviderError { return new AgentProviderError(code, message, recoverable, LOCAL_MANUAL_PROVIDER_ID); }
function normalize(cause: unknown, code: AgentProviderErrorCode, recoverable: boolean): AgentProviderError {
  return cause instanceof AgentProviderError ? cause : error(code, cause instanceof Error ? cause.message : String(cause), recoverable);
}
function cancelled(): AgentProviderError { return error("CANCELLED", "Local manual result wait was cancelled; external work has not been stopped."); }
function hasCode(value: unknown, code: string): boolean { return typeof value === "object" && value !== null && "code" in value && value.code === code; }
function loadSchema(path: string): Record<string, unknown> {
  try {
    const schema = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assertSupportedSchema(schema);
    return deepFreeze(schema);
  } catch (cause: unknown) { throw normalize(cause, "INVALID_REQUEST", false); }
}
function validateControls(request: AgentRunRequest): void {
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw error("INVALID_REQUEST", "Request must be an object.");
  const allowed = new Set(["taskId", "role", "revisionIdentity", "runId", "actorId", "contextPackage", "toolPermissionPolicy", "signal", "timeoutMs"]);
  for (const key of Reflect.ownKeys(request)) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key)!;
    if (typeof key !== "string" || !allowed.has(key) || !descriptor.enumerable || !("value" in descriptor)) throw error("INVALID_REQUEST", "Request has unknown, hidden or accessor fields.");
  }
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > MAX_TIMEOUT_MS)) throw error("INVALID_REQUEST", `timeoutMs must be a positive integer <= ${MAX_TIMEOUT_MS}.`);
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) throw error("INVALID_REQUEST", "signal must be an AbortSignal.");
}
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(cancelled()); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
