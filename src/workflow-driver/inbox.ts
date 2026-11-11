import { existsSync, lstatSync, readFileSync } from "node:fs";
import { FileManualAgentProvider } from "../local-agent-adapter/index.js";
import { createLocalReviewReworkGate } from "../review-rework/index.js";
import { FileDeveloperStartStateStore, type DeveloperStartResult } from "../dev-start/index.js";
import { FileAssignmentLockStore, isAssignmentLockExpired } from "../assignment-lock/index.js";
import { FileOrchestrationRunStore } from "../orchestration-engine/index.js";
import { files, git, hash, id, now, object, read, redact, requireValue, safePath, stableId, validate, write, clean } from "./io.js";
import { diagnostic, loadSession, mapMarkdown, prepare, register, saveSession, sessionPath } from "./intake.js";
import type { DriverProfile, DriverResponse, DriverSession, IntakeRecord } from "./model.js";

export const successorId = (sessionId:string):string => stableId(`${sessionId}:successor`);
export async function followSuccessors(root:string,p:DriverProfile,session:DriverSession):Promise<DriverSession> {
  for(let depth=0;depth<10;depth++) {
    if(!existsSync(sessionPath(root,successorId(session.sessionId))))return session;
    session=await successor(root,p,session);
  }
  requireValue(!existsSync(sessionPath(root,successorId(session.sessionId))),"Linked rework chain exceeds the supported limit; inspect preserved records.");
  return session;
}
export async function successor(root: string, p: DriverProfile, s: DriverSession): Promise<DriverSession> {
  const state = new FileDeveloperStartStateStore(safePath(root, ".agent/state/lifecycle"));
  const nextId = successorId(s.sessionId);
  const path = safePath(root, `.agent/driver/sessions/${nextId}.json`);
  const existing = existsSync(path) ? loadSession(root,p,nextId) : null;
  requireValue(!existing||(existing.predecessor===s.sessionId&&existing.taskId===s.taskId&&existing.definitionHash===s.definitionHash&&existing.request.ownerId===s.request.ownerId&&
    existing.request.assignmentRunId===(s.request.assignmentRunId??s.request.runId)&&existing.request.assignmentKey===(s.request.assignmentKey??s.request.idempotencyKey)),"Saved successor has an invalid predecessor binding.");
  const lifecycle=state.get(s.taskId);
  if(existing && lifecycle?.history.some(e=>e.toState==="IN_DEVELOPMENT"&&e.runId===`${existing.request.runId}::resume-rework`))return existing;
  requireValue(lifecycle?.currentState === "REWORK_REQUIRED", "A new judgment needs legal rework. Administrative reset remains a separate quiescent host-authorized operation.");
  const head=clean(root);
  const journalStore=new FileOrchestrationRunStore(safePath(root,".agent/state/orchestration"));
  const original=journalStore.get(s.request.assignmentKey??s.request.idempotencyKey!);
  const current=journalStore.get(s.request.idempotencyKey!);
  const start=original?.values.start as DeveloperStartResult|undefined;
  const predecessor=current?.values.start as DeveloperStartResult|undefined;
  const lock=new FileAssignmentLockStore(safePath(root,".agent/state/assignments")).get(s.taskId);
  requireValue(start&&predecessor&&original?.runId===(s.request.assignmentRunId??s.request.runId)&&current?.runId===s.request.runId&&
    start.taskId===s.taskId&&predecessor.taskId===s.taskId&&predecessor.assignment.lockId===start.assignment.lockId&&
    lock?.status==="ACTIVE"&&lock.ownerId===s.request.ownerId&&lock.lockId===start.assignment.lockId&&lock.runId===start.assignment.runId&&
    lock.canonicalBranch===start.canonicalBranch&&git(root,"branch","--show-current")===start.canonicalBranch&&!isAssignmentLockExpired(lock,now()),"Rework requires the predecessor's exact original active assignment.","ASSIGNMENT_MISMATCH");
  const reworkEntry=[...lifecycle.history].reverse().find(event=>event.toState==="REWORK_REQUIRED");
  requireValue(reworkEntry?.revisionIdentity===head&&reworkEntry.actorId===s.request.ownerId&&
    (reworkEntry.runId===`${s.request.runId}::review-rework`||(reworkEntry.runId?.startsWith("recovery:")&&reworkEntry.evidenceRef?.startsWith(".agent/state/recovery/"))),"Rework does not belong to the current failed attempt or an authorized recovery.");
  const nextRun = id();
  const next: DriverSession = existing ?? { ...s, sessionId: nextId, predecessor: s.sessionId, pendingPacket: null, developerPacket:null,diagnosticId: null, result: null, status: "PREPARED",
    request: { ownerId: s.request.ownerId, runId: nextRun, idempotencyKey: nextRun, assignmentRunId: s.request.assignmentRunId ?? s.request.runId, assignmentKey:s.request.assignmentKey??s.request.idempotencyKey!,occurredAt: now() } };
  // Intent survives a crash before/after the owning transition. A saved successor
  // cannot execute until resumeDevelopment has actually entered IN_DEVELOPMENT.
  saveSession(root, next);
  const rework = await createLocalReviewReworkGate(root);
  rework.resumeDevelopment({ taskId: s.taskId, actorId: p.roleActors.Developer, runId: `${next.request.runId}::resume-rework`, occurredAt: next.request.occurredAt });
  s.status = "STOPPED"; saveSession(root, s);
  return next;
}

function unwrap(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const match = /^```json\s*\n([\s\S]*?)\n```$/.exec(trimmed);
    requireValue(match && !match[1]!.includes("```"), "Save exactly one fenced JSON block with no surrounding prose.");
    return JSON.parse(match[1]!) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}

export async function scan(root: string, p: DriverProfile, session: DriverSession | null): Promise<{session:DriverSession|null; receipts:unknown[]}> {
  const receipts: unknown[] = [];
  for (const name of files(safePath(root, p.paths.issues), ".md")) {
    try {
      const bytes=stable(root,safePath(root,`${p.paths.issues}/${name}`)); if(bytes===null)continue;
      const receipt=safePath(root,`${p.paths.archive}/${hash({issue:bytes,profile:hash(p)})}.issue.json`);
      if(existsSync(receipt))continue;
      const intake = await prepare(root,p,bytes); const captured={intakeId:intake.intakeId,sessionId:intake.diagnostics.length?null:intake.sessionId};
      if(intake.sessionId&&intake.diagnostics.length)continue;
      write(receipt,captured,true); receipts.push(captured);
    }
    catch (error) { receipts.push({ issueFile: name, diagnosticId: diagnostic(root, p, "INTAKE_ERROR", error instanceof Error ? error.message : "Cannot prepare issue.") }); }
  }
  const incoming = new Map<string,string>();
  for (const name of files(safePath(root, p.paths.responses), ".json").concat(files(safePath(root, p.paths.responses), ".md"))) {
    let bytes:string|null;
    try { bytes=stable(root,safePath(root,`${p.paths.responses}/${name}`)); }
    catch { diagnostic(root,p,"INBOX_UNREADABLE","An inbox entry is not a bounded regular file. Save a new regular file atomically.");continue; }
    if(bytes!==null)incoming.set(hash(bytes),bytes);
  }
  for (const name of files(safePath(root,p.paths.archive),".input.json")) {
    const inputHash=name.slice(0,-".input.json".length);
    if(incoming.has(inputHash)||existsSync(safePath(root,`${p.paths.archive}/${inputHash}.receipt.json`)))continue;
    const capture=read(safePath(root,`${p.paths.archive}/${name}`));
    if(object(capture)&&typeof capture.original==="string"&&hash(capture.original)===inputHash)incoming.set(inputHash,capture.original);
  }
  for (const [inputHash,bytes] of incoming) {
    const receiptPath = safePath(root, `${p.paths.archive}/${inputHash}.receipt.json`);
    if (existsSync(receiptPath)) continue;
    let packetId: string | null = null, diagnosticId: string | null = null;
    let status = "ACCEPTED", nextAction = "Continue the same driver session.";
    try {
      requireValue(redact(bytes)===bytes,"Remove host credentials from the response before importing.");
      const input = unwrap(bytes); requireValue(object(input), "Response must be one JSON object.");
      requireValue(typeof input.packetId === "string" && /^[a-f0-9]{64}$/.test(input.packetId), "Response has no valid packet binding."); packetId = input.packetId;
      if (input.schemaId === "ipt.local-agent-result") {
        if(!session)continue;
        if(session.pendingPacket!==packetId && files(safePath(root,".agent/driver/sessions"),".json").some(name=>{const record=read(safePath(root,`.agent/driver/sessions/${name}`));return object(record)&&record.pendingPacket===packetId&&record.profileHash===hash(p)&&record.status==="WAITING";}))continue;
        requireValue(session && session.pendingPacket === packetId && session.status === "WAITING", "Result does not belong to this session's current pending packet.");
        const exchange = new FileManualAgentProvider(safePath(root, p.paths.exchange), { repositoryRoot: root });
        const packet = exchange.readPacket(packetId);
        const head=clean(root,packet.role==="Developer"?undefined:packet.revisionIdentity);
        const definition=JSON.parse(git(root,"show",`${head}:${session.definitionPath}`)) as {canonicalBranch?:string};
        requireValue(hash(definition)===session.definitionHash&&git(root,"branch","--show-current")===definition.canonicalBranch&&packet.taskId===session.taskId&&packet.runId.startsWith(`${session.request.runId}::`),"Response belongs to a stale source or attempt.");
        if(packet.role==="Developer")git(root,"merge-base","--is-ancestor",packet.revisionIdentity,head);
        write(safePath(root,`${p.paths.archive}/${inputHash}.input.json`),{original:bytes},true);
        const result = exchange.importResult(packetId, input, accepted=>{
          clean(root,head);
          requireValue(git(root,"branch","--show-current")===definition.canonicalBranch,"Source branch changed before publication.");
          write(safePath(root,`.agent/driver/accepted/${packet.packetId}.json`),{sessionId:session!.sessionId,packetId:packet.packetId,head,role:packet.role,status:accepted.status,resultHash:hash(accepted)},true);
        });
        status = result.reused ? "REUSED" : "ACCEPTED";
      } else {
        validate(root, "driver-response", input);
        const response = input as unknown as DriverResponse;
        requireValue(response.projectRoot === root && response.profileHash === hash(p), "Response belongs to another repository/profile.");
        const packet = read(safePath(root, `${p.paths.outbound}/${packetId}.diagnostic.json`));
        requireValue(object(packet) && packet.packetId === packetId && packet.profileHash === response.profileHash, "Unknown diagnostic binding.");
        if (response.action === "clarify") {
          requireValue(response.sessionId===undefined,"Intake clarification cannot include a session ID.");
          requireValue(response.intakeId === packet.intakeId && typeof response.intakeId === "string" && /^[a-f0-9]{64}$/.test(response.intakeId), "Clarification intake mismatch.");
          const intake = read(safePath(root, `.agent/driver/intakes/${response.intakeId}.json`)) as unknown as IntakeRecord;
          requireValue(!intake.sessionId && response.task && Number.isSafeInteger(response.issueNumber), "Clarification requires a proposed complete task and issue number; existing registration is immutable.");
          requireValue(intake.issueNumber===null||response.issueNumber===intake.issueNumber,"Clarification cannot replace the operator-selected issue.");
          const mapped=mapMarkdown(intake.source);
          requireValue(!mapped.diagnostics.some(message=>message.startsWith("Duplicate or contradictory")),"Resolve contradictory issue fields in operator-selected Markdown before registration.");
          for(const [key,value] of Object.entries(mapped.known)) {
            const proposed=(response.task as unknown as Record<string,unknown>)[key];
            requireValue(proposed!==undefined&&hash(value)===hash(proposed),`Clarification cannot change the explicit '${key}' field.`);
          }
          const accepted = await register(root, p, { ...intake, task: response.task, issueNumber: response.issueNumber! });
          nextAction = `Prepared session ${accepted.sessionId}; explicitly select it with orchestrate run.`;
        } else {
          if(!session)continue;
          requireValue(response.task===undefined&&response.intakeId===undefined&&response.issueNumber===undefined,"Repair cannot change task or issue inputs.");
          requireValue(response.sessionId === session.sessionId && session.diagnosticId === packetId, "Repair is stale or belongs to another session.");
          clean(root, typeof packet.revision === "string" ? packet.revision : undefined);
          const attempts=safePath(root,`.agent/driver/repair-attempts/${packetId}`), intent=safePath(root,`.agent/driver/repair-attempts/${packetId}/${inputHash}.json`);
          requireValue(existsSync(intent)||files(attempts,".json").length<p.manual.maxAttempts,"Repair proposal budget exhausted for this diagnostic. Inspect the original records and explicitly resume after resolving the prerequisite.");
          write(intent,{packetId,inputHash,action:response.action},true);
          if (response.action === "rework") { session = await successor(root, p, session); nextAction = `Continue linked successor ${session.sessionId}.`; }
          else { session.diagnosticId = null; saveSession(root, session); }
        }
      }
    } catch (error) {
      status = "REJECTED"; nextAction = "Correct the unaccepted response and save it again; retain the original pending packet. Terminal outcomes require legal rework.";
      const detail=error instanceof Error ? error.message : "Invalid response.";
      const pending=session?.pendingPacket;
      if(session&&pending&&(packetId===null||packetId===pending)&&!existsSync(safePath(root,`${p.paths.exchange}/${pending}.result.json`))) {
        let handoff:unknown;
        try{handoff=read(safePath(root,`${p.paths.outbound}/${pending}.handoff.json`));}catch{/* Retain the pending packet if the companion needs regeneration. */}
        diagnosticId=diagnostic(root,p,"REJECTED_INPUT",detail,session,null,object(handoff)?handoff:undefined);
      } else diagnosticId = diagnostic(root, p, "REJECTED_INPUT", detail);
    }
    // Captured original and receipt are append-only. Import-first ordering is safe:
    // if receipt writing crashes, the immutable adapter reports reused next scan.
    write(safePath(root, `${p.paths.archive}/${inputHash}.input.json`), { original: redact(bytes) }, true);
    const receipt = { schemaId: "ipt.driver-receipt", schemaVersion: "1.0.0", inputHash, packetId, status, occurredAt: now(), diagnosticId, nextAction };
    validate(root, "driver-receipt", receipt); write(receiptPath, receipt, true); receipts.push(receipt);
  }
  return { session, receipts };
}

function stable(root: string, path: string): string|null {
  const stat = lstatSync(path) as ReturnType<typeof lstatSync> & {size:number};
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024, "Inbox input must be a regular file at most 4 MiB.");
  const bytes=readFileSync(path,"utf8");
  const snapshot = { size: stat.size, content: hash(bytes) };
  const observed = safePath(root, `.agent/driver/observations/${hash(path)}.json`);
  const previous = existsSync(observed) ? read(observed) as {size:number;content:string;at:number} : null;
  if (previous && previous.size === snapshot.size && previous.content === snapshot.content) return Date.now() - previous.at >= 500 ? bytes : null;
  write(observed, { ...snapshot, at: Date.now() }); return null;
}
