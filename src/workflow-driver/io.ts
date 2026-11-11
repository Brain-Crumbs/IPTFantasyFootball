import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, linkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson } from "../local-agent-adapter/json.js";
import { assertSupportedSchema, schemaErrors } from "../local-agent-adapter/schema.js";

export class DriverError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DriverError"; }
}
export const hash = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
export const now = (): string => new Date().toISOString();
export const id = (): string => randomUUID();
export const stableId = (value:unknown):string => hash(value).slice(0,32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
export function redact(value:string,extra?:string):string {
  for(const credential of [extra,process.env.IPT_GITHUB_TOKEN,process.env.GITHUB_TOKEN])if(credential)value=value.split(credential).join("[redacted]");
  return value;
}
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function requireValue(v: unknown, message: string, code = "INVALID_INPUT"): asserts v { if (!v) throw new DriverError(code, message); }
export function git(root: string, ...args: string[]): string {
  return gitInEnvironment(root,process.env,...args);
}
export function gitInEnvironment(root:string,env:Readonly<Record<string,string|undefined>>,...args:string[]):string {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],env:{...env,GIT_TERMINAL_PROMPT:"0"},timeout:45000 }).trim(); }
  catch { throw new DriverError("GIT_FAILED", `Git operation '${args[0]}' failed. Check repository access and configured remote; credentials are not included in diagnostics.`); }
}
export function clean(root: string, expected?: string): string {
  requireValue(git(root, "status", "--porcelain").length === 0, "Commit or preserve outstanding source changes before continuing.", "DIRTY_SOURCE");
  const revision = git(root, "rev-parse", "HEAD");
  requireValue(expected === undefined || revision === expected, "Source revision changed; preserve records and use legal rework.", "HEAD_CHANGED");
  return revision;
}
export function safePath(root: string, path: string): string {
  const target = resolve(root, path), rel = relative(root, target);
  requireValue(rel !== "" && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel), "Path must stay inside the selected project.");
  let cursor = root;
  for (const part of rel.split(/[\\/]/)) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) requireValue(!lstatSync(cursor).isSymbolicLink(), "Symlinks are not supported for workflow inputs or outputs.");
  }
  return target;
}
export function read(path: string): unknown {
  const attributes = lstatSync(path) as ReturnType<typeof lstatSync> & {size:number};
  requireValue(attributes.isFile() && !attributes.isSymbolicLink() && attributes.size <= 4 * 1024 * 1024, "Input must be a regular file at most 4 MiB.");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
export function write(path: string, value: unknown, immutable = false): void {
  writeText(path, `${pretty(value)}\n`, immutable);
}
export const pretty = (value: unknown): string => JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
export function writeText(path: string, bytes: string, immutable = false): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) requireValue(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile(), "Artifact must be a regular file.");
  if (immutable && existsSync(path)) { requireValue(readFileSync(path, "utf8") === bytes, "Immutable artifact conflicts with existing input.", "IDENTITY_CONFLICT"); return; }
  const temp = `${path}.${id()}.tmp`;
  const fd = openSync(temp, "wx");
  try { writeFileSync(fd, bytes, { encoding: "utf8" }); fsyncSync(fd); } finally { closeSync(fd); }
  try { if (immutable) linkSync(temp, path); else renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function schema(root: string, family: string): Record<string, unknown> { const value = read(safePath(root, `schemas/v1/${family}.schema.json`)); requireValue(object(value), "Missing schema."); return value; }
export function validate(root: string, family: string, value: unknown): void {
  const spec = schema(root, family); assertSupportedSchema(spec);
  const errors = schemaErrors(value, spec); requireValue(errors.length === 0, `Invalid ${family}: ${errors.slice(0, 8).join("; ")}`);
}
export function files(path: string, suffix: string): string[] { return existsSync(path) ? readdirSync(path).filter(name => name.endsWith(suffix) && !name.startsWith(".")).sort() : []; }
export async function exclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = safePath(root, ".agent/driver/writer.lock"); mkdirSync(dirname(lock), { recursive: true });
  const recovery=safePath(root,".agent/driver/writer-recovery.lock");
  requireValue(!existsSync(recovery),"Writer recovery is in progress.","DRIVER_BUSY");
  try { writeFileSync(lock, id(), { flag: "wx" }); } catch { throw new DriverError("DRIVER_BUSY", "Another driver holds the writer lock. Never steal it by age. After a crash, stop all writers and use the documented offline recovery procedure."); }
  try { requireValue(!existsSync(recovery),"Writer recovery is in progress.","DRIVER_BUSY");return await action(); } finally { unlinkSync(lock); }
}
export function recoverWriter(root:string,expectedHash:string,reason:string):string {
  const lock=safePath(root,".agent/driver/writer.lock"), recovery=safePath(root,".agent/driver/writer-recovery.lock");
  writeFileSync(recovery,id(),{flag:"wx"});
  try {
    const token=readFileSync(lock,"utf8");requireValue(hash(token)===expectedHash,"Writer lock changed. Recheck it after stopping all writers.","RECOVERY_CONFLICT");
    const audit=safePath(root,`.agent/driver/writer-recovery/${expectedHash}.json`);
    if(!existsSync(audit))write(audit,{expectedHash,reason,confirmedQuiescent:true,occurredAt:now()},true);
    requireValue(hash(readFileSync(lock,"utf8"))===expectedHash,"Writer lock changed.","RECOVERY_CONFLICT");
    renameSync(lock,safePath(root,`.agent/driver/writer-recovery/${expectedHash}.archived-lock`));
    return audit;
  } finally {unlinkSync(recovery);}
}
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
