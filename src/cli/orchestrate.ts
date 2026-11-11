import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_RUNNER_ROLES } from "../agent-provider/index.js";
import { LocalRecoveryTools, recoveryHash } from "../recovery-tools/index.js";
import { loadTaskRegistry, selectNextEligibleTask } from "../task-registry/index.js";
import { readLocalLifecycleStates } from "../status-reporting/index.js";
import { clean, DriverError, exclusive, files, git, hash, object, recoverWriter, requireValue, safePath, sleep, validate, write } from "../workflow-driver/io.js";
import { PROFILE, checkedProfile, diagnostic, loadProfile, loadSession, prepare, selectRegistered } from "../workflow-driver/intake.js";
import { step, publish, type DriverRuntime } from "../workflow-driver/driver.js";
import { scan, successor } from "../workflow-driver/inbox.js";
import type { DriverProfile, DriverSession } from "../workflow-driver/model.js";

export const ORCHESTRATE_HELP = `orchestrate init --base main --checks "Build and test (Node),Schema and contract validation (Python)" --actor-prefix operator --developer-tools read_file,write_file,git_commit --review-tools read_file,run_test --enforce-policies externally [--repository owner/repo]
orchestrate prepare --stdin | --issue-file path.md
orchestrate run|resume <session-id> [--once]
orchestrate watch [session-id] [--once]
orchestrate status [session-id]
orchestrate next
orchestrate select <registered-task-id> --issue-number N
orchestrate publish|ready|rework <session-id>
orchestrate recover|recover-run <session-id> --quiescent --reason text [--authorization-ref reference]
orchestrate inspect-writer | recover-writer --quiescent --lock-hash HASH --reason text
Manual steps: copy outbound .handoff.json.md into a fresh role chat, then save raw JSON in inbox/responses. Publication, ready conversion and exact-head merge authority are explicit operations. Ctrl+C stops this driver; stop external agents separately.`;

function argsFor(args: readonly string[]) {
  const positional: string[] = [], flags = new Map<string,string>();
  for (let i=0;i<args.length;i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    requireValue(!flags.has(arg), `Duplicate option ${arg}.`);
    if (["--stdin", "--once", "--quiescent"].includes(arg)) flags.set(arg, "true");
    else { const value = args[++i]; requireValue(value && !value.startsWith("--"), `Missing value for ${arg}.`); flags.set(arg,value); }
  }
  return {positional, flags};
}

export async function runOrchestrateCommand(args: readonly string[], repositoryRoot: string, runtime: DriverRuntime = {}): Promise<{data:unknown;human:string}> {
  const root = resolve(repositoryRoot);
  if (args.length === 0 || args[0] === "help") return {data:{usage:ORCHESTRATE_HELP},human:ORCHESTRATE_HELP};
  const {positional, flags} = argsFor(args), operation = positional[0]!;
  const allowed: Record<string,string[]> = {
    init:["--base","--checks","--actor-prefix","--developer-tools","--review-tools","--enforce-policies","--repository","--max-attempts","--retry-delay-ms","--role-timeout-ms","--issues-dir","--responses-dir","--outbound-dir","--archive-dir","--exchange-dir"], prepare:["--stdin","--issue-file"],
    run:["--once"],resume:["--once"],watch:["--once"],status:[],next:[],select:["--issue-number"],publish:[],ready:[],rework:[],recover:["--quiescent","--reason","--authorization-ref"],"recover-run":["--quiescent","--reason"],"inspect-writer":[],"recover-writer":["--quiescent","--lock-hash","--reason"] };
  requireValue(allowed[operation] && [...flags.keys()].every(flag=>allowed[operation]!.includes(flag)), `Unsupported operation/option. ${ORCHESTRATE_HELP}`);
  requireValue(positional.length <= (operation === "init" || operation === "prepare" || operation === "next" ? 1 : 2), "Unexpected positional arguments.");
  let p: DriverProfile | null = null;
  try {
    if (operation === "init") {
      const get = (key:string) => { const value=flags.get(key); requireValue(value, `Setup requires explicit ${key}. ${ORCHESTRATE_HELP}`); return value; };
      requireValue(get("--enforce-policies") === "externally", "Externally enforce the printed role policies in fresh sessions.");
      requireValue(git(root,"rev-parse","--show-toplevel").replaceAll("\\","/").toLowerCase() === root.replaceAll("\\","/").toLowerCase(), "Choose the repository root.");
      const remote = git(root,"remote","get-url","origin");
      const discovered = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
      const repository = flags.get("--repository") ?? discovered; requireValue(repository && (!discovered || repository === discovered), "Supply --repository owner/repo matching origin.");
      const prefix = get("--actor-prefix"), base=get("--base"); requireValue(base==="main","This bootstrap repository integrates on main.");git(root,"rev-parse","--verify",`${base}^{commit}`);
      const split=(key:string)=>get(key).split(",").map(x=>x.trim()).filter(Boolean);
      const developerTools=split("--developer-tools"), reviewTools=split("--review-tools");
      requireValue(!reviewTools.some(tool=>/write|commit|merge|push/i.test(tool)), "Review policies must exclude source writes/publication/merge.");
      p = {schemaId:"ipt.driver-profile",schemaVersion:"1.0.0",repository,integrationTarget:base,requiredCiChecks:split("--checks"),
        paths:{issues:flags.get("--issues-dir")??".agent/driver/inbox/issues",responses:flags.get("--responses-dir")??".agent/driver/inbox/responses",outbound:flags.get("--outbound-dir")??".agent/driver/outbound",archive:flags.get("--archive-dir")??".agent/driver/archive",exchange:flags.get("--exchange-dir")??".agent/driver/exchange"},
        manual:{maxAttempts:Number(flags.get("--max-attempts")??3),retryDelayMs:Number(flags.get("--retry-delay-ms")??100),roleTimeoutMs:Number(flags.get("--role-timeout-ms")??5000)},
        roleActors:Object.fromEntries(AGENT_RUNNER_ROLES.map(role=>[role,`${prefix}::${role}`])) as DriverProfile["roleActors"],
        rolePolicies:Object.fromEntries(AGENT_RUNNER_ROLES.map(role=>[role,{allowedTools:role==="Developer"?developerTools:role==="MergeController"?[]:reviewTools,deniedTools:role==="Developer"?["merge"]:["write_file","git_commit","push","merge"],networkAccess:"none"}])) as unknown as DriverProfile["rolePolicies"]};
      p=checkedProfile(root,p);
      // Refuse to place runtime state in a checkout that would track it.
      requireValue(git(root,"check-ignore",".agent/driver/probe").length>0,"Add .agent/ to the project's .gitignore before setup.");
      write(safePath(root,PROFILE),p,true); p=loadProfile(root);
      for(const path of Object.values(p.paths)) mkdirSync(safePath(root,path),{recursive:true});
      mkdirSync(safePath(root,"tasks/definitions"),{recursive:true});
      return {data:{profile:p,profilePath:safePath(root,PROFILE)},human:`Setup complete for ${p.repository}.\n${JSON.stringify(p,null,2)}\nPaste issue Markdown with orchestrate prepare --stdin, or drop .md files in ${p.paths.issues}.\n${ORCHESTRATE_HELP}`};
    }
    p=loadProfile(root);
    if(operation==="inspect-writer") {
      const lock=safePath(root,".agent/driver/writer.lock");const data={lockHash:existsSync(lock)?hash(readFileSync(lock,"utf8")):null};return {data,human:JSON.stringify(data)};
    }
    if(operation==="recover-writer") {
      const expected=flags.get("--lock-hash"),reason=flags.get("--reason");
      requireValue(flags.has("--quiescent")&&expected&&/^[a-f0-9]{64}$/.test(expected)&&reason,"Stop all local and external writers; supply --quiescent, observed --lock-hash and --reason.");
      const auditPath=recoverWriter(root,expected,reason);return {data:{auditPath},human:`Writer token archived: ${auditPath}. Use recover-run if a native orchestration token also remains.`};
    }
    if(operation==="status") {
      const result=positional[1]?loadSession(root,p,positional[1]):files(safePath(root,".agent/driver/sessions"),".json").map(name=>loadSession(root,p!,name.slice(0,-5)));
      return {data:result,human:JSON.stringify(result,null,2)};
    }
    if(operation==="next") {
      const registry=await loadTaskRegistry({repositoryRoot:root});
      const result=selectNextEligibleTask(registry,{taskStates:readLocalLifecycleStates(root,registry)});
      return {data:result,human:`${JSON.stringify(result,null,2)}\nExplicitly choose a prepared session with orchestrate run SESSION. No assignment occurred.`};
    }
    const profile=p;
    if(["watch","run","resume"].includes(operation)) {
      let session=positional[1]?loadSession(root,profile,positional[1]):null;
      requireValue(operation==="watch"||session,"Supply the prepared session ID. No task is selected implicitly.");
      const receipts:unknown[]=[];let first=true;
      do {
        try {await exclusive(root,async()=>{
          if(session)session=loadSession(root,profile,session.sessionId);
          const before=session?`${session.status}:${session.pendingPacket}:${session.diagnosticId}`:"";
          const scanned=await scan(root,profile,session);session=scanned.session;
          receipts.push(...scanned.receipts);if(receipts.length>50)receipts.splice(0,receipts.length-50);
          for(const receipt of scanned.receipts)if(object(receipt)) {
            if(typeof receipt.sessionId==="string")runtime.progress?.(`Prepared session ${receipt.sessionId}; explicitly select it with orchestrate run.`);
            else if(typeof receipt.intakeId==="string")runtime.progress?.(`Intake ${receipt.intakeId} needs clarification. See ${profile.paths.outbound}.`);
            else if(typeof receipt.nextAction==="string")runtime.progress?.(`${String(receipt.status)}: ${receipt.nextAction}`);
          }
          if(session&&(first||scanned.receipts.some(r=>object(r)&&(r.status==="ACCEPTED"||r.status==="REUSED"))))session=await step(root,profile,session,runtime);
          if(session&&before!==`${session.status}:${session.pendingPacket}:${session.diagnosticId}`)runtime.progress?.(`Session ${session.sessionId}: ${session.status}. ${session.pendingPacket?`Open ${profile.paths.outbound}/${session.pendingPacket}.handoff.json.md.`:""} ${session.diagnosticId?`Diagnostic ${session.diagnosticId}.`:""}`);
          first=false;
        });} catch(error){if(operation!=="watch"||flags.has("--once")||!(error instanceof DriverError)||error.code!=="DRIVER_BUSY")throw error;}
        if(operation!=="watch"||flags.has("--once")||runtime.signal?.aborted)break;
        await sleep(600);
      }while(!runtime.signal?.aborted);
      return {data:{session,receipts,reportDirectory:session?`.agent/driver/reports/${session.sessionId}`:null},human:`${session?`Session ${session.sessionId}: ${session.status}. Pending packet: ${session.pendingPacket??"none"}. Diagnostic: ${session.diagnosticId??"none"}.\nReports: .agent/driver/reports/${session.sessionId}`:"Inbox scan complete; explicitly select a prepared session."}\nHandoffs: ${profile.paths.outbound}\nResponses: ${profile.paths.responses}\nReceipts: ${profile.paths.archive}\nCtrl+C stops local waiting; external role sessions require separate termination.`};
    }
    return await exclusive(root,async()=>{
      if(operation==="select") {
        requireValue(positional[1],"Supply a registered task ID.");
        const selected=await selectRegistered(root,profile,positional[1],Number(flags.get("--issue-number")));
        return {data:selected,human:`Prepared registered task ${selected.taskId}. Run orchestrate run ${selected.sessionId} to request assignment.`};
      }
      if(operation==="prepare") {
        requireValue(flags.has("--stdin") !== flags.has("--issue-file"),"Choose exactly --stdin or --issue-file.");
        const source=flags.has("--stdin")?readFileSync(0,"utf8"):readFileSync(resolve(root,flags.get("--issue-file")!),"utf8");
        const intake=await prepare(root,profile,source);
        return {data:intake,human:intake.sessionId?`Prepared session ${intake.sessionId}. Run orchestrate run ${intake.sessionId}. Registration was committed; no task was assigned.`:`Clarification needed. Open the diagnostic handoff in ${profile.paths.outbound}, then drop its response in ${profile.paths.responses} and run orchestrate watch --once.`};
      }
      let session:DriverSession|null=positional[1]?loadSession(root,profile,positional[1]):null;
      if(operation==="publish"||operation==="ready") {requireValue(session,"Supply a session ID.");const result=await publish(root,profile,session,runtime,operation==="ready");return {data:result,human:JSON.stringify(result,null,2)};}
      if(operation==="rework") {requireValue(session,"Supply a session ID.");const next=await successor(root,profile,session);return {data:next,human:`Linked successor ${next.sessionId}; run orchestrate resume ${next.sessionId}.`};}
      if(operation==="recover"||operation==="recover-run") {
        requireValue(session&&flags.has("--quiescent")&&flags.get("--reason"),"Stop/verify all writers and external sessions; provide session, --quiescent and --reason.");
        clean(root);
        const path=operation==="recover"?`.agent/state/lifecycle/${session.taskId}.lifecycle.json`:".agent/state/orchestration/.orchestration.lock";
        const tools=await LocalRecoveryTools.create(root,{authorizeOverride:req=>(process.env.IPT_RECOVERY_ADMIN_ACTORS??"").split(",").includes(req.actorId)});
        const authorizationRef=flags.get("--authorization-ref");
        requireValue(operation!=="recover"||authorizationRef,"Administrative reset requires --authorization-ref plus trusted host IPT_RECOVERY_ADMIN_ACTORS.");
        const result=await tools.apply({schemaVersion:"1.0.0",operationId:`driver-${hash({session:session.sessionId,path,prior:readFileSync(safePath(root,path),"utf8")}).slice(0,40)}`,operation:operation==="recover"?"reset-task":"release-run-lock",taskId:session.taskId,actorId:profile.roleActors.Developer,reason:flags.get("--reason"),expectedRevision:clean(root),expectedTargetHash:recoveryHash(readFileSync(safePath(root,path),"utf8")),confirmedQuiescent:true,...(authorizationRef?{override:{authorizationRef}}:{}),...(operation==="recover-run"?{idempotencyKey:session.request.idempotencyKey}:{})});
        return {data:result,human:`Recovery audited. ${operation==="recover"?`Run orchestrate rework ${session.sessionId} to create a linked new attempt.`:"Resume the original session."}`};
      }
      throw new DriverError("INVALID_INPUT","Unsupported operation.");
    });
  } catch(error) {
    const code=error instanceof DriverError?error.code:"DRIVER_ERROR",message=error instanceof Error?error.message:"Driver failed.";
    let diagnosticId:string|null=null;try{diagnosticId=diagnostic(root,p,code,message);}catch{/* stdout remains usable if disk/config is unavailable. */}
    throw new DriverError(code,`${message}${diagnosticId?` Diagnostic: ${diagnosticId}`:" Diagnostic could not be persisted; restore writable project storage/configuration, then retry."}`);
  }
}
