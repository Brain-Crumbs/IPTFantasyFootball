import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTaskRegistry, loadTaskRegistryFromPaths, validateDependencyDag, type TaskRecord } from "../task-registry/index.js";
import { DEFAULT_REQUIRED_CI_CHECKS } from "../merge-readiness/index.js";
import type { DriverProfile, DriverSession, IntakeRecord } from "./model.js";
import { clean, files, git, hash, id, now, read, redact, requireValue, safePath, schema, validate, write, writeText } from "./io.js";

export const PROFILE = ".agent/driver/profile.json";
export function loadProfile(root: string): DriverProfile {
  return checkedProfile(root,read(safePath(root, PROFILE)));
}
export function checkedProfile(root:string,profile:unknown):DriverProfile {
  validate(root,"driver-profile",profile);
  const p=profile as DriverProfile;
  requireValue(p.integrationTarget==="main","The bootstrap integration target is main.");
  requireValue(new Set(Object.values(p.roleActors)).size === 5, "All five role actors must be distinct; enforce each policy in fresh external sessions.");
  requireValue(p.requiredCiChecks.length > 0 && new Set(p.requiredCiChecks).size === p.requiredCiChecks.length, "Configure distinct required CI checks.");
  requireValue(DEFAULT_REQUIRED_CI_CHECKS.every(name => p.requiredCiChecks.includes(name)), "Profile must preserve the repository's required CI checks.");
  requireValue([p.manual.maxAttempts,p.manual.retryDelayMs,p.manual.roleTimeoutMs].every(Number.isSafeInteger)&&p.manual.maxAttempts>=1&&p.manual.maxAttempts<=10&&p.manual.retryDelayMs>=0&&p.manual.retryDelayMs<=60000&&p.manual.roleTimeoutMs>=1&&p.manual.roleTimeoutMs<=2147483647,"Manual retry/timeout settings must be bounded integers.");
  const paths = Object.values(p.paths).map(path => {
    requireValue(/^\.agent\/driver\/(?:inbox\/|files\/)?[A-Za-z0-9 _-]+$/.test(path)&&!/(?:^|\/)(?:sessions|staged|intakes|observations|accepted|selections|reports|repair-attempts|writer-recovery)$/i.test(path),"Exchange paths must be dedicated ignored directories under .agent/driver; use forward slashes.");
    return safePath(root,path);
  });
  requireValue(paths.every((path, i) => paths.every((other, j) => i === j || (!path.startsWith(`${other}/`) && !path.startsWith(`${other}\\`) && path !== other))), "Input, archive, output and canonical exchange directories must remain separate.");
  return p;
}
export const sessionPath = (root: string, sessionId: string): string => {
  requireValue(/^[a-f0-9-]{36}$/.test(sessionId), "Invalid session ID."); return safePath(root, `.agent/driver/sessions/${sessionId}.json`);
};
export function loadSession(root: string, p: DriverProfile, sessionId: string): DriverSession {
  const s = read(sessionPath(root, sessionId)); validate(root, "driver-session", s);
  const value = s as unknown as DriverSession;
  requireValue(value.sessionId === sessionId && value.projectRoot === root && value.profileHash === hash(p), "Session belongs to a different project or profile; restore the original profile.", "SESSION_CONFLICT");
  return value;
}
export function saveSession(root: string, s: DriverSession): void { validate(root, "driver-session", s); write(sessionPath(root, s.sessionId), s); }
export async function selectRegistered(root: string, p: DriverProfile, taskId: string, issueNumber: number): Promise<DriverSession> {
  requireValue(Number.isSafeInteger(issueNumber) && issueNumber > 0, "Explicitly supply a positive issue number.");
  const registry = await loadTaskRegistry({repositoryRoot:root});
  const task = registry.get(taskId); requireValue(task, "Select an existing registered task ID.");
  requireValue(task.canonicalBranch !== p.integrationTarget, "Task branch cannot be the integration target.");
  const revision = clean(root), definitionPath = task.sourcePath.replaceAll("\\","/");
  const definitionHash = hash(JSON.parse(git(root,"show",`${revision}:${definitionPath}`)));
  for(const name of files(safePath(root,".agent/driver/sessions"),".json")) {
    const prior=loadSession(root,p,name.slice(0,-5));
    if(prior.taskId===taskId&&prior.predecessor===null) {
      requireValue(prior.issueNumber===issueNumber&&prior.definitionHash===definitionHash,"Task already has a session with different source or issue metadata.","SESSION_CONFLICT");
      return prior;
    }
  }
  const intakeId = hash({taskId,issueNumber,definitionHash,profileHash:hash(p),root});
  const binding = safePath(root,`.agent/driver/selections/${intakeId}.json`);
  if (existsSync(binding)) return loadSession(root,p,(read(binding) as {sessionId:string}).sessionId);
  const sessionId=id(), runId=id();
  const s:DriverSession={schemaId:"ipt.driver-session",schemaVersion:"1.0.0",sessionId,projectRoot:root,profileHash:hash(p),intakeId,taskId,issueNumber,definitionPath,definitionHash,registrationRevision:revision,
    request:{ownerId:p.roleActors.Developer,runId,idempotencyKey:runId,occurredAt:now()},status:"PREPARED",pendingPacket:null,diagnosticId:null,predecessor:null,result:null};
  saveSession(root,s);write(binding,{sessionId},true);return s;
}

export function diagnostic(root: string, p: DriverProfile | null, code: string, message: string, session: DriverSession | null = null, intake: IntakeRecord | null = null): string {
  message=redact(message).slice(0,8192);
  const revision = (() => { try { return git(root, "rev-parse", "HEAD"); } catch { return null; } })();
  const taskContext=session?{taskId:session.taskId,issueNumber:session.issueNumber,runId:session.request.runId,pendingPacket:session.pendingPacket,definitionHash:session.definitionHash,
    stage:session.result?.stopped?.stage??null,completedStages:session.result?.stages.map(stage=>({stage:stage.stage,outcome:stage.outcome,evidenceRefs:stage.evidenceRefs}))??[],evidenceDirectory:".agent/state/evidence",reportDirectory:`.agent/driver/reports/${session.sessionId}`} : null;
  const binding = { projectRoot: root, profileHash: p ? hash(p) : "unconfigured", sessionId: session?.sessionId ?? null, intakeId: intake?.intakeId ?? null, revision, code, message,taskContext };
  const packetId = hash(binding);
  const rework=session?.result?.finalLifecycleState==="REWORK_REQUIRED";
  const continuation = intake ? "Return a proposed full task plus issueNumber using action clarify. Do not invent missing requirements. Registration remains schema/DAG checked."
    : rework ? "Propose legal rework to start a linked Developer attempt. The predecessor remains immutable."
    : "Fix the stated external prerequisite, then return action recheck or run orchestrate resume. A new judgment needs action rework and legal gates; administrative recovery needs a quiescent host-authorized operator.";
  const responseTemplate = { schemaId: "ipt.driver-response", schemaVersion: "1.0.0", projectRoot: root, profileHash: binding.profileHash, packetId,
    action: intake ? "clarify" : rework ? "rework" : "recheck", ...(intake ? { intakeId: intake.intakeId, task: "<propose a complete ipt.task record>", issueNumber: intake.issueNumber??"<operator-selected GitHub issue number>" } : session ? { sessionId: session.sessionId } : {}) };
  const packet = { schemaId: "ipt.driver-diagnostic", schemaVersion: "1.0.0", packetId, ...binding, continuation, responseSchema: schema(root, "driver-response"), responseTemplate };
  validate(root,"driver-diagnostic",packet);
  const output = safePath(root, `${p?.paths.outbound ?? ".agent/driver/outbound"}/${packetId}.diagnostic.json`);
  write(output, packet, true);
  writeText(safePath(root, `${output}.md`), `# Workflow ${intake ? "clarification" : "repair"} handoff\n\nUse a fresh session. Work only in ${root}. This packet grants no gate, recovery or merge authority. If tools/checkout are unavailable, explain the blocker.\n\n${message}\n\n${continuation}\n\nSave exactly one JSON response in ${p?.paths.responses ?? ".agent/driver/inbox/responses"}. No commands in a response are executed.\n\n\x60\x60\x60json\n${JSON.stringify({ ...packet, ...(intake ? { originalIssue: intake.source, proposedTaskSchema: schema(root, "task") } : {}) }, null, 2)}\n\x60\x60\x60\n`, true);
  if (session) { session.diagnosticId = packetId; session.status = "WAITING"; saveSession(root, session); }
  return packetId;
}

/** Documented headings have explicit empty lists ('- none'); missing never means empty. */
export function mapMarkdown(source: string): { task: TaskRecord | null; issueNumber: number | null; issueUrl:string|null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const unique=(pattern:RegExp,name:string):string|undefined=>{const matches=[...source.matchAll(pattern)];if(matches.length>1)diagnostics.push(`Duplicate or contradictory '${name}'.`);return matches.length===1?matches[0]![1]?.trim():undefined;};
  const field = (name: string): string | undefined => unique(new RegExp(`^\\*{0,2}${name}:\\*{0,2}[ \\t]*\x60?([^\r\n\x60]+)`, "gim"),name);
  const section = (name: string): string | undefined => unique(new RegExp(`^## ${name}[ \\t]*\r?\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "gim"),name);
  const task: Record<string, unknown> = { schemaId: "ipt.task", schemaVersion: "1.0.0", taskId: field("Task ID"), canonicalBranch: field("Canonical branch"), title: /^# (.+)$/m.exec(source)?.[1]?.trim(), objective: section("Objective") };
  const sections: Record<string, string> = { inScope: "In scope", outOfScope: "Out of scope", dependencies: "Dependencies", allowedPaths: "Allowed paths", requirements: "Requirements", acceptanceCriteria: "Acceptance criteria", validationPlan: "Validation plan", affectedContracts: "Affected contracts", requiredReviewRoles: "Required review roles" };
  for (const [key, heading] of Object.entries(sections)) {
    const text = section(heading);
    if (text === undefined) { diagnostics.push(`Missing explicit '${heading}' section (use '- none' for an intentional empty list).`); continue; }
    const items = text.split(/\r?\n/).map(line => /^- (?:\[[ x]\] )?(.+)$/.exec(line)?.[1]?.trim());
    if (items.some(item => !item)) { diagnostics.push(`'${heading}' must contain only '- value' list entries.`); continue; }
    task[key] = items.length === 1 && items[0] === "none" ? [] : items;
  }
  for (const key of ["taskId", "canonicalBranch", "title", "objective"]) if (!task[key]) diagnostics.push(`Missing ${key}.`);
  const issue = field("Issue");
  const issueUrl=issue&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[0-9]+$/.test(issue)?issue:null;
  const number = issueUrl?Number(issueUrl.split("/").at(-1)):issue&&/^#?[0-9]+$/.test(issue)?Number(issue.replace(/^#/,"")):NaN;
  if (!Number.isSafeInteger(number) || number < 1) diagnostics.push("Missing positive Issue number or GitHub issue URL.");
  return { task: diagnostics.length ? null : task as unknown as TaskRecord, issueNumber: Number.isSafeInteger(number) && number > 0 ? number : null, issueUrl, diagnostics };
}

export async function prepare(root: string, p: DriverProfile, source: string): Promise<IntakeRecord> {
  requireValue(source.trim().length > 0 && source.length <= 4 * 1024 * 1024, "Issue Markdown must be nonempty and at most 4 MiB.");
  requireValue(redact(source)===source,"Remove host credentials from the issue before preparation.");
  const intakeId = hash({ source, profile: hash(p), projectRoot: root });
  const path = safePath(root, `.agent/driver/intakes/${intakeId}.json`);
  let intake: IntakeRecord;
  if (existsSync(path)) {
    const saved = read(path); validate(root, "driver-intake", saved); intake = saved as unknown as IntakeRecord;
    if (intake.sessionId) return intake.diagnostics.length?finishRegistration(root,p,intake,loadSession(root,p,intake.sessionId)):intake;
  } else {
    const mapped = mapMarkdown(source);
    requireValue(!mapped.issueUrl||mapped.issueUrl.startsWith(`https://github.com/${p.repository}/issues/`),"Issue URL belongs to another repository.","REPOSITORY_MISMATCH");
    intake = { schemaId: "ipt.driver-intake", schemaVersion: "1.0.0", intakeId, projectRoot: root, profileHash: hash(p), sourceHash: hash(source), source, ...mapped, sessionId: null };
    write(path, intake, true);
  }
  if (intake.task && intake.issueNumber) {
    try { return await register(root, p, intake); }
    catch (error) { intake.diagnostics = [error instanceof Error ? error.message : "Registration failed."]; write(path, intake); }
  }
  diagnostic(root, p, "INTAKE_CLARIFICATION", intake.diagnostics.join("\n"), null, intake);
  return intake;
}

export async function register(root: string, p: DriverProfile, intake: IntakeRecord): Promise<IntakeRecord> {
  requireValue(intake.projectRoot === root && intake.profileHash === hash(p) && intake.task && Number.isSafeInteger(intake.issueNumber) && intake.issueNumber! > 0, "Clarification binding or issue metadata is incomplete.");
  const task = intake.task;
  requireValue(/^[A-Z]+-[0-9]{3,}$/.test(task.taskId), "Invalid task identifier.");
  requireValue(task.requiredReviewRoles.includes("Developer") && task.requiredReviewRoles.includes("MergeController"), "The supported driver requires Developer and MergeController roles.");
  git(root, "check-ref-format", "--branch", task.canonicalBranch);
  requireValue(task.canonicalBranch !== p.integrationTarget, "Canonical branch cannot be the integration target.");
  const stage = safePath(root, `.agent/driver/staged/${intake.intakeId}/${hash(task)}/${task.taskId}.task.json`);
  write(stage, task, true);
  const staged = await loadTaskRegistryFromPaths([stage], { repositoryRoot: root, schemaPath: join(root, "schemas/v1/task.schema.json") });
  const registry = await loadTaskRegistry({ repositoryRoot: root });
  const existing = registry.get(task.taskId);
  requireValue(!existing, `Task ID '${task.taskId}' already exists. Inspect its source or existing session; changed input cannot overwrite it.`, "TASK_CONFLICT");
  requireValue(![...registry.values()].some(item=>item.canonicalBranch===task.canonicalBranch),"Another task already owns this canonical branch.","TASK_CONFLICT");
  for(const name of files(safePath(root,".agent/driver/intakes"),".json")) {
    const prior=read(safePath(root,`.agent/driver/intakes/${name}`)) as IntakeRecord;
    requireValue(prior.intakeId===intake.intakeId||prior.issueNumber!==intake.issueNumber||!prior.sessionId,"Changed issue content cannot replace an existing registered task/session.","INTAKE_CONFLICT");
  }
  const combined = new Map([...registry, ...staged]);
  const dag = validateDependencyDag(combined); requireValue(dag.length === 0, `Dependency validation failed: ${JSON.stringify(dag)}`);
  // Context compilation is the authority for requirement/contract references; staging
  // uses the normal catalog and compiler before exposing the definition.
  const { RepositoryDeveloperContextSource } = await import("../dev-start/index.js");
  const { compileRoleContext } = await import("../context-compiler/index.js");
  const source = new RepositoryDeveloperContextSource(root);
  const revision = clean(root);
  const artifacts = source.artifactsFor(staged.get(task.taskId)!, combined, revision);
  compileRoleContext({ task: staged.get(task.taskId)!, role: "Developer", registry: combined, revision, artifacts });
  requireValue(git(root, "branch", "--show-current") === p.integrationTarget, "Publish task registration only from the configured integration branch.");
  const definitionPath = `tasks/definitions/${task.taskId.toLowerCase()}.task.json`;
  // Write-ahead registration intent: interruption leaves the complete staged record
  // and an explicit dirty-source wait, never an assigned partially registered task.
  const sessionId = id(), runId = id();
  const session: DriverSession = { schemaId: "ipt.driver-session", schemaVersion: "1.0.0", sessionId, projectRoot: root, profileHash: hash(p), intakeId: intake.intakeId, taskId: task.taskId, issueNumber: intake.issueNumber!, definitionPath, definitionHash: hash(task), registrationRevision: revision,
    request: { ownerId: p.roleActors.Developer, runId, idempotencyKey: runId, occurredAt: now() }, status: "PREPARED", pendingPacket: null, diagnosticId: null, predecessor: null, result: null };
  saveSession(root, session);
  intake.sessionId = sessionId; intake.diagnostics = ["Registration commit pending."];
  write(safePath(root, `.agent/driver/intakes/${intake.intakeId}.json`), intake);
  return finishRegistration(root, p, intake, session);
}

function finishRegistration(root: string, p: DriverProfile, intake: IntakeRecord, session: DriverSession): IntakeRecord {
  requireValue(intake.task && hash(intake.task) === session.definitionHash, "Registration intent no longer matches the staged definition.");
  requireValue(git(root, "branch", "--show-current") === p.integrationTarget, "Return to the integration branch to resume the interrupted registration.");
  const target = safePath(root, session.definitionPath);
  const changed = git(root,"status","--porcelain").split(/\r?\n/).filter(Boolean);
  requireValue(changed.every(line => line.slice(3) === session.definitionPath), "Unrelated edits prevent resuming registration; preserve them separately.");
  let alreadyCommitted = false;
  try { alreadyCommitted = hash(JSON.parse(git(root,"show",`HEAD:${session.definitionPath}`))) === session.definitionHash; } catch { /* Not committed yet. */ }
  if (!alreadyCommitted) {
    requireValue(git(root,"rev-parse","HEAD") === session.registrationRevision, "Base changed during registration; inspect the staged definition before continuing.");
    write(target, intake.task, true);
    git(root, "add", "--", session.definitionPath);
    git(root, "commit", "--only", "-m", `Register operator-selected ${session.taskId} from issue #${session.issueNumber}`, "--", session.definitionPath);
  }
  session.registrationRevision = clean(root); saveSession(root, session);
  intake.diagnostics = []; write(safePath(root, `.agent/driver/intakes/${intake.intakeId}.json`), intake);
  return intake;
}
