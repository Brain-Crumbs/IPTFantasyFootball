import { existsSync } from "node:fs";
import { AgentRunner, type AgentRunRequest } from "../agent-provider/index.js";
import { FileManualAgentProvider, type LocalAgentPacket } from "../local-agent-adapter/index.js";
import { SequentialOrchestrationEngine, FileOrchestrationRunStore } from "../orchestration-engine/index.js";
import { createLocalDeveloperStartWorkflow, FileDeveloperStartStateStore } from "../dev-start/index.js";
import { createLocalDeveloperValidationGate } from "../dev-validation/index.js";
import { createLocalQaReviewGate } from "../qa-review/index.js";
import { createLocalArchitectureReviewGate } from "../architecture-review/index.js";
import { createLocalUatReviewGate } from "../uat-review/index.js";
import { createLocalReviewReworkGate } from "../review-rework/index.js";
import { createLocalMergeReadinessPolicyEngine, type FetchLike } from "../merge-readiness/index.js";
import { createLocalControlledMergeController } from "../controlled-merge/index.js";
import { createLocalPullRequestLifecycleAdapter } from "../pr-lifecycle/index.js";
import { createLocalWorkflowDiagnostics } from "../workflow-diagnostics/index.js";
import { loadTaskRegistry, selectNextEligibleTask } from "../task-registry/index.js";
import { readLocalLifecycleStates } from "../status-reporting/index.js";
import { clean, DriverError, git, hash, now, object, pretty, read, redact, requireValue, safePath, schema, write, writeText } from "./io.js";
import { diagnostic, loadSession, saveSession, sessionPath } from "./intake.js";
import { successorId } from "./inbox.js";
import type { DriverProfile, DriverSession } from "./model.js";

export interface DriverRuntime { signal?: AbortSignal; fetchImpl?: FetchLike; token?: string; mergeAuthorization?: string; progress?: (message:string)=>void; }
function githubTransport(runtime:DriverRuntime):FetchLike {
  return runtime.fetchImpl??((url,init)=>globalThis.fetch(url,{...init,signal:AbortSignal.timeout(30000),redirect:"error"}));
}
function validatorEnvironment():Readonly<Record<string,string|undefined>> {
  const allowed=/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|TMP|TEMP|TMPDIR|APPDATA|LOCALAPPDATA|LANG|LC_ALL|TZ|PYTHONPATH|PYTHONHOME)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key])=>allowed.test(key)));
}
function observe(root:string,s:DriverSession,event:string,revision:string):void {
  const snapshot={event,sessionId:s.sessionId,taskId:s.taskId,runId:s.request.runId,revision,status:s.status,pendingPacket:s.pendingPacket,
    diagnosticId:s.diagnosticId,stages:s.result?.stages??[],stop:s.result?.stopped??null};
  const path=safePath(root,`.agent/driver/reports/${s.sessionId}/${hash(snapshot)}.json`);
  if(!existsSync(path))write(path,{...snapshot,observedAt:now()},true);
}
interface GithubPull {
  number:number; node_id?:string; title:string; body:string; draft:boolean; state:string;
  merged?:boolean; merged_at?:string|null;
  head:{sha:string;ref:string;repo:{full_name:string}};base:{ref:string;repo:{full_name:string}};
}
function assertPull(pr:GithubPull,p:DriverProfile,s:DriverSession,branch:string,head?:string,allowConfirmed=false):void {
  const acceptedState=pr?.state==="open"||(allowConfirmed&&pr?.state==="closed"&&(pr.merged===true||!!pr.merged_at));
  requireValue(pr&&acceptedState&&Number.isSafeInteger(pr.number)&&pr.number>0&&pr.head?.ref===branch&&pr.base?.ref===p.integrationTarget&&
    pr.head?.repo?.full_name?.toLowerCase()===p.repository.toLowerCase()&&pr.base?.repo?.full_name?.toLowerCase()===p.repository.toLowerCase()&&
    typeof pr.title==="string"&&pr.title.startsWith(`${s.taskId}:`)&&typeof pr.body==="string"&&new RegExp(`^Closes #${s.issueNumber}\\s*$`,"m").test(pr.body)&&
    (head===undefined||pr.head.sha===head),"Open PR conflicts with the selected repository, task, issue, branch, base, or exact source.","PR_CONFLICT");
}
interface RemoteTarget { readUrl:string; pushUrl:string }
function assertRemote(root: string, p: DriverProfile, runtime: DriverRuntime, expected?:RemoteTarget): RemoteTarget {
  const accepted = [`https://github.com/${p.repository}.git`, `https://github.com/${p.repository}`, `git@github.com:${p.repository}.git`];
  requireValue(accepted.includes(git(root,"config","--get","remote.origin.url")), "Origin differs from the configured repository.");
  const readUrls=git(root,"remote","get-url","--all","origin").split(/\r?\n/);
  const pushUrls=git(root,"remote","get-url","--push","--all","origin").split(/\r?\n/);
  requireValue(readUrls.length===1&&pushUrls.length===1,"Origin must have one read URL and one push URL; no additional publication targets are authorized.");
  if (!runtime.fetchImpl) requireValue(accepted.includes(readUrls[0]!)&&accepted.includes(pushUrls[0]!),"Origin URL rewrite or push URL targets a different repository.");
  const current={readUrl:readUrls[0]!,pushUrl:pushUrls[0]!};
  requireValue(!expected||(current.readUrl===expected.readUrl&&current.pushUrl===expected.pushUrl),"Origin changed during publication; recheck the repository before retrying.");
  return current;
}
export function roleHandoff(root: string, p: DriverProfile, s: DriverSession, packet: LocalAgentPacket): void {
  const details = packet.role === "QA" ? { acceptanceCriteriaScenarios: ["<actual scenarios>"], regressionNegativeCaseCoverage: ["<actual checks>"] }
    : packet.role === "Architect" ? { affectedContractsModules: ["<modules>"], dependencyConsumerSurfaces: ["<consumers>"], semanticCompatibilityAssessment: "<actual assessment>", invariantDependencyRuleAssessment: "<actual assessment>" }
    : packet.role === "UAT/Product" ? { intendedOutcomesScenarios: ["<actual scenarios>"], observedBehavior: ["<actual observation>"] } : { summary: "<actual work and evidence>" };
  const template = { schemaId: "ipt.local-agent-result", schemaVersion: "1.0.0", ...packet.resultBinding, status: "COMPLETED", result: {
    runId: packet.runId, providerId: packet.providerId, taskId: packet.taskId, role: packet.role, revisionIdentity: packet.revisionIdentity,
    outcome: "<PASS, FAIL or BLOCKED after actual work>", details, findings: [], evidenceRefs: [], occurredAt: "<RFC3339 timestamp>", nonPass: { reason: "<required for FAIL/BLOCKED; omit nonPass for PASS>", remediation: "<next legal action>" } } };
  const envelope = { schemaId: "ipt.driver-handoff", schemaVersion: "1.0.0", projectRoot: root, repository: p.repository, sessionId: s.sessionId,
    issue: `https://github.com/${p.repository}/issues/${s.issueNumber}`, canonicalBranch: packet.contextPackage.task.canonicalBranch ?? git(root, "branch", "--show-current"),
    responseDirectory: p.paths.responses, packet, responseSchema: schema(root, "local-agent-result"), responseTemplate: template };
  const path = safePath(root, `${p.paths.outbound}/${packet.packetId}.handoff.json`);
  write(path, envelope, true);
  writeText(safePath(root, `${path}.md`), `# ${packet.role} handoff\n\nOpen a fresh session with checkout and tools at ${root}. Read AGENTS.md, CONSTITUTION.md and BOOTSTRAP.md. Enforce toolPermissionPolicy externally; actor labels do not enforce permissions. If access is missing, return ERROR. Do not invent success. Developer may commit; reviewers must preserve source. Never edit lifecycle/evidence or merge.\n\nUse exactly the compiled context below, without other roles' private conversation. Return one raw JSON object or one fenced JSON block, with no surrounding prose, to ${p.paths.responses}. Keep every binding unchanged. Fill actual role details/evidence and actual PASS/FAIL/BLOCKED judgment. Non-PASS needs reason/remediation and structured findings; ERROR/CANCELLED uses the response schema's terminal error shape, never fabricated PASS. Accepted terminal results are immutable.\n\n\x60\x60\x60json\n${pretty(envelope)}\n\x60\x60\x60\n`, true);
}
export function github(root: string, p: DriverProfile, s:DriverSession, runtime: DriverRuntime) {
  const [owner, repo] = p.repository.split("/") as [string, string];
  const token = runtime.token ?? process.env.IPT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  const request: FetchLike = async (url, init) => {
    requireValue(token.length > 0, "Configure IPT_GITHUB_TOKEN in the host environment, then resume the same session.", "CREDENTIALS_REQUIRED");
    const endpoint = new URL(url);
    requireValue(endpoint.origin === "https://api.github.com" && endpoint.pathname.startsWith(`/repos/${p.repository}/`), "GitHub action must target the configured consumer repository.");
    const isMerge = init.method === "PUT" && /\/pulls\/\d+\/merge$/.test(endpoint.pathname);
    if (isMerge) {
      const head = clean(root), number = Number(endpoint.pathname.split("/").at(-2));
      requireValue((runtime.mergeAuthorization ?? process.env.IPT_DRIVER_MERGE) === `${p.repository}#${number}@${head}`, "Set host IPT_DRIVER_MERGE to the exact repository#PR@full-SHA after reviewing readiness.", "MERGE_AUTHORIZATION_REQUIRED");
      const body = JSON.parse(init.body ?? "{}") as { sha?: string }; requireValue(body.sha === head, "Merge transport SHA differs from current authorized HEAD.");
      const remote=assertRemote(root,p,runtime);
      const branch=git(root,"branch","--show-current");
      requireValue(git(root,"ls-remote",remote.readUrl,`refs/heads/${branch}`).split(/\s/)[0]===head,"Remote branch changed before merge.");
      const checked=await githubTransport(runtime)(url.replace(/\/merge$/,""),{method:"GET",headers:init.headers}).catch(()=>{throw new DriverError("GITHUB_UNAVAILABLE","Cannot confirm the exact PR before merge.");});
      const pr=await checked.json() as GithubPull;
      requireValue(checked.ok && pr.draft===false,"PR must be ready for review and still target the authorized exact source.");
      assertPull(pr,p,s,branch,head);requireValue(pr.number===number,"PR number changed before merge.");
      clean(root,head);assertRemote(root,p,runtime,remote);
    }
    const modified = init.method === "POST" && endpoint.pathname.endsWith("/pulls") ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body ?? "{}"), draft: true }) } : init;
    try {
      const response = await githubTransport(runtime)(url, modified);
      // Redact before any adapter can persist an upstream message in its journal.
      return { ok: response.ok, status: response.status, json: async () => {
        const value: unknown = await response.json(); return JSON.parse(JSON.stringify(value).split(token).join("[redacted]")) as unknown;
      } };
    } catch { throw new DriverError("GITHUB_UNAVAILABLE", "GitHub transport failed. Check host credentials/network and resume the original request."); }
  };
  return { owner, repo, token: token || "unconfigured", fetchImpl: request, integrationTarget: p.integrationTarget, requiredCiChecks: p.requiredCiChecks };
}

export async function step(root: string, p: DriverProfile, s: DriverSession, runtime: DriverRuntime = {}): Promise<DriverSession> {
  try {
    const registry = await loadTaskRegistry({ repositoryRoot: root }), task = registry.get(s.taskId);
    const head = clean(root);
    observe(root,s,"before",head);
    requireValue(task && [head,s.registrationRevision].every(rev=>hash(JSON.parse(git(root,"show",`${rev}:${s.definitionPath}`)))===s.definitionHash), "Task definition is not committed or changed under the original session.", "SESSION_CONFLICT");
    clean(root);
    const journalStore = new FileOrchestrationRunStore(safePath(root, ".agent/state/orchestration"));
    const bound = journalStore.get(s.request.idempotencyKey!);
    if (!bound?.values.start && !s.request.assignmentRunId) {
      const selection = selectNextEligibleTask(registry, { taskStates: readLocalLifecycleStates(root, registry) });
      requireValue(selection.kind === "selected" && selection.taskId === s.taskId, `Authorized task ${s.taskId} is not the next eligible task. Inspect orchestrate next; no assignment was made.`, "TASK_NOT_ELIGIBLE");
      requireValue([p.integrationTarget, task.canonicalBranch].includes(git(root, "branch", "--show-current")), "Start from the integration target or the task's canonical branch.");
    }
    const state = new FileDeveloperStartStateStore(safePath(root, ".agent/state/lifecycle"));
    if(s.predecessor) requireValue(state.get(s.taskId)?.history.some(e=>e.toState==="IN_DEVELOPMENT"&&e.runId===`${s.request.runId}::resume-rework`),"Successor has no authoritative rework transition. Reconcile the predecessor's rework intent.");
    if(existsSync(sessionPath(root,successorId(s.sessionId))))throw new DriverError("SUPERSEDED_ATTEMPT",`Use linked successor ${successorId(s.sessionId)}. The predecessor remains audit history.`);
    const exchange = new FileManualAgentProvider(safePath(root, p.paths.exchange), { repositoryRoot: root });
    const accepted = (packetId:string) => {
      const v=read(safePath(root,`.agent/driver/accepted/${packetId}.json`));
      requireValue(object(v)&&v.sessionId===s.sessionId&&v.packetId===packetId&&typeof v.head==="string"&&v.resultHash===hash(read(exchange.resultPath(packetId))),"Result lacks a valid current driver intake fence.");
      clean(root,v.head);return v;
    };
    const g = github(root, p, s, runtime);
    const intentPath=safePath(root,`.agent/driver/merge-intents/${s.sessionId}.json`);
    type MergeIntent={sessionId:string;repository:string;issueNumber:number;branch:string;number:number;head:string};
    let intent:MergeIntent|null=null;
    if(existsSync(intentPath)) {
      const saved=read(intentPath) as MergeIntent;
      requireValue(saved.sessionId===s.sessionId&&saved.repository===p.repository&&saved.issueNumber===s.issueNumber&&saved.branch===task.canonicalBranch&&
        Number.isSafeInteger(saved.number)&&saved.number>0&&/^[a-f0-9]{40,64}$/.test(saved.head),"Invalid exact merge authorization record.");
      intent=saved;
    }
    const mergeTransport:FetchLike=async(url,init)=>{
      requireValue(intent,"Merge calls require the recorded exact authorized attempt.");
      const authorized=intent,endpoint=new URL(url);
      const match=/\/pulls\/(\d+)(?:\/merge)?$/.exec(endpoint.pathname);
      if(match)requireValue(Number(match[1])===authorized.number,"Remote merge call selected an unauthorized PR.");
      if(init.method==="PUT")requireValue((JSON.parse(init.body??"{}") as {sha?:string}).sha===authorized.head,"Remote merge call selected an unauthorized source.");
      // For historical discovery, query the one PR for which this session
      // actually recorded a grant. Another merged PR on the same SHA is not
      // evidence for this attempt. Open-PR readiness still sees all candidates.
      const history=init.method==="GET"&&endpoint.pathname.endsWith("/pulls")&&endpoint.searchParams.get("state")==="all";
      const response=await g.fetchImpl(history?`${endpoint.origin}${endpoint.pathname}/${authorized.number}`:url,init);
      if(!response.ok||init.method!=="GET"||(!match&&!history))return response;
      return {ok:response.ok,status:response.status,json:async()=>{
        const pr=await response.json() as GithubPull;
        assertPull(pr,p,s,authorized.branch,authorized.head,true);
        requireValue(pr.number===authorized.number,"GitHub returned a different PR.");
        return history?[pr]:pr;
      }};
    };
    const [start, validation, qa, architecture, uat, rework, readiness, merge] = await Promise.all([
      createLocalDeveloperStartWorkflow(root), createLocalDeveloperValidationGate(root), createLocalQaReviewGate(root), createLocalArchitectureReviewGate(root), createLocalUatReviewGate(root), createLocalReviewReworkGate(root), createLocalMergeReadinessPolicyEngine(root, g), createLocalControlledMergeController(root, {...g,fetchImpl:mergeTransport}) ]);
    const prepareAgentInput = (input: AgentRunRequest): boolean => {
      if (input.role !== "Developer") clean(root, input.revisionIdentity);
      else git(root,"merge-base","--is-ancestor",input.revisionIdentity,clean(root));
      requireValue(git(root,"branch","--show-current")===task.canonicalBranch,"Role input is only valid on its canonical branch.");
      const packet = exchange.exportPacket(input);
      roleHandoff(root, p, s, packet);
      if (s.pendingPacket!==packet.packetId) s.diagnosticId=null;
      if(packet.role==="Developer")s.developerPacket=packet.packetId;
      s.pendingPacket = packet.packetId; s.status = "WAITING"; saveSession(root, s);
      observe(root,s,"manual-handoff",clean(root));
      if(!existsSync(exchange.resultPath(packet.packetId)))return false;
      const record=accepted(packet.packetId);
      const stage=input.runId.split("::").at(-1)!;
      if(record.status!=="COMPLETED"&&bound?.lastFailure&&(bound.attempts[stage]??0)>0)throw new DriverError("TERMINAL_ROLE_RESULT","The original terminal outcome is immutable. Use the legal recovery/rework path for a new judgment.");
      return true;
    };
    const guarded = <T>(action: () => T): T => { const before = clean(root); const result = action(); clean(root, before); return result; };
    const reviewGate = <T extends { prepareContext: (input: {taskId:string}) => unknown; review: (input: never) => unknown }>(gate: T): T => ({ ...gate,
      prepareContext: (input: {taskId:string}) => guarded(() => gate.prepareContext(input)), review: (input: never) => guarded(() => gate.review(input)) }) as T;
    const engine = new SequentialOrchestrationEngine({ taskRegistry: registry, lifecycleState: state, runStore: journalStore, developerStart: { start: input => start.start({...input, authorizedTaskId:s.taskId}) },
      developerValidation: { validate: input => { const before=clean(root);requireValue(s.developerPacket&&accepted(s.developerPacket).role==="Developer","Developer validation requires the original accepted response and its source fence.");return validation.validate({...input,routeFirstReview:true,commandEnvironment:validatorEnvironment(),assertSource:revision=>{
        requireValue(revision===before&&git(root,"branch","--show-current")===task.canonicalBranch,"Validation must stay on the exact canonical source.");clean(root,before);
      }}); } },
      qaReview: reviewGate(qa), architectureReview: reviewGate(architecture), uatReview: reviewGate(uat), reviewRework: rework,
      mergeReadiness: { evaluate: async input => { clean(root); return readiness.evaluate(input); } },
      controlledMerge: { merge: async input => {
        if (!intent) {
          const head = clean(root), ready = await readiness.evaluate({ taskId: s.taskId });
          requireValue(ready.ready&&ready.pullRequestNumber&&ready.revision===head&&(runtime.mergeAuthorization ?? process.env.IPT_DRIVER_MERGE) === `${p.repository}#${ready.pullRequestNumber}@${head}`, "Exact repository/PR/head host authorization and ready CI are required before controlled merge.", "MERGE_AUTHORIZATION_REQUIRED");
          const token=runtime.token??process.env.IPT_GITHUB_TOKEN??process.env.GITHUB_TOKEN;
          requireValue(token,"Host GitHub credentials are required.");
          const response=await g.fetchImpl(`https://api.github.com/repos/${p.repository}/pulls/${ready.pullRequestNumber}`,{method:"GET",headers:{Authorization:`Bearer ${token}`}});
          const pr=await response.json() as GithubPull;
          requireValue(response.ok&&pr.draft===false&&pr.number===ready.pullRequestNumber,"Only the exact ready-for-review PR can receive a merge intent.");
          assertPull(pr,p,s,task.canonicalBranch,head);clean(root,head);
          intent={sessionId:s.sessionId,repository:p.repository,issueNumber:s.issueNumber,branch:task.canonicalBranch,number:pr.number,head};
          write(intentPath,intent,true);
        }
        return merge.merge(input);
      } }, agentRunner: new AgentRunner({ provider: exchange }), prepareAgentInput,
      retryPolicy:{maxAttempts:p.manual.maxAttempts,delayMs:p.manual.retryDelayMs},timeoutMsFor:()=>p.manual.roleTimeoutMs,
      actorIdFor: role => p.roleActors[role], toolPermissionPolicyFor: role => p.rolePolicies[role] });
    const result = await engine.run({ ...s.request, ...(runtime.signal ? { signal: runtime.signal } : {}) });
    s.result = result; s.status = result.status === "COMPLETED" ? "DONE" : "STOPPED"; s.pendingPacket = null; if(s.status==="DONE")s.diagnosticId=null; saveSession(root, s);
    if (s.status !== "DONE") diagnostic(root, p, "WORKFLOW_STOPPED", `${result.stopped?.reason ?? "Stopped"}\n${result.stopped?.remediation ?? ""}\nWhen reviews are complete: orchestrate publish SESSION, orchestrate ready SESSION, then resume with exact host merge authorization.`, s);
    else {
      const next = selectNextEligibleTask(registry,{taskStates:readLocalLifecycleStates(root,registry)});
      const completion=safePath(root,`${p.paths.outbound}/${s.sessionId}.completed.json`);
      if(!existsSync(completion))write(completion,{sessionId:s.sessionId,taskId:s.taskId,runId:result.runId,pullRequestNumber:result.pullRequestNumber,mergeCommitSha:result.mergeCommitSha,next,nextAction:"Inspect orchestrate next and explicitly select the prepared session; no new task has been assigned."},true);
    }
    observe(root,s,"after",git(root,"rev-parse","HEAD"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "WAITING_INPUT") return s;
    if(s.pendingPacket&&existsSync(safePath(root,`${p.paths.exchange}/${s.pendingPacket}.result.json`)))s.pendingPacket=null;
    const code = error instanceof Error && "code" in error ? String(error.code) : "DRIVER_ERROR";
    diagnostic(root, p, code, redact(error instanceof Error ? error.message : "Driver operation failed; inspect preserved records.",runtime.token), s);
  }
  return s;
}

export async function publish(root: string, p: DriverProfile, s: DriverSession, runtime: DriverRuntime, ready = false): Promise<unknown> {
  const registry = await loadTaskRegistry({ repositoryRoot: root }), task = registry.get(s.taskId)!;
  const head = clean(root);
  requireValue(task&&hash(JSON.parse(git(root,"show",`${head}:${s.definitionPath}`)))===s.definitionHash,"Task definition differs from the original session.");
  const diagnostics = await createLocalWorkflowDiagnostics(root);
  const assertEvidence = () => { clean(root, head);requireValue(git(root,"branch","--show-current")===task.canonicalBranch,"Publish only the canonical task branch.");const at = now(), v = diagnostics.explainValidation(s.taskId, at), r = diagnostics.explainReviews(s.taskId, at);
    requireValue(v.clear && r.clear && v.revision === head && r.revision === head && r.state === "MERGE_READY", "Publication requires current deterministic validation and all declared independent review gates.", "STALE_EVIDENCE"); };
  assertEvidence();
  const remote=assertRemote(root,p,runtime);
  const g = github(root, p, s, runtime);
  const token = runtime.token ?? process.env.IPT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  requireValue(token,"Configure host IPT_GITHUB_TOKEN before publication.");
  const headers={Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json"};
  const api=`https://api.github.com/repos/${p.repository}/pulls`;
  const candidate=async(exact?:string):Promise<GithubPull|null>=>{
    const response=await g.fetchImpl(`${api}?state=open&head=${encodeURIComponent(`${g.owner}:${task.canonicalBranch}`)}&per_page=100`,{method:"GET",headers});
    const pulls=await response.json() as GithubPull[];
    requireValue(response.ok&&Array.isArray(pulls)&&pulls.length<=1,"Cannot confirm a single canonical PR; inspect conflicting remote pull requests.","PR_CONFLICT");
    const pr=pulls[0]; if(pr)assertPull(pr,p,s,task.canonicalBranch,exact);return pr??null;
  };
  const assertPublished=()=>{
    assertEvidence();
    assertRemote(root,p,runtime,remote);
    requireValue(git(root,"ls-remote",remote.readUrl,`refs/heads/${task.canonicalBranch}`).split(/\s/)[0]===head,"Remote branch has not published this exact source SHA.","REMOTE_HEAD_MISMATCH");
  };
  const existing=await candidate();assertEvidence();
  if (ready) {
    requireValue(existing,"Publish the canonical draft first; ready never creates a pull request.");
    assertPublished();
    const checked=await g.fetchImpl(`${api}/${existing.number}`,{method:"GET",headers});
    const pr=await checked.json() as GithubPull;
    requireValue(checked.ok&&pr.number===existing.number&&pr.node_id,"Unable to verify the exact PR node for ready conversion.");
    assertPull(pr,p,s,task.canonicalBranch,head);assertPublished();
    if(pr.draft===false)return {number:pr.number,revision:head,ready:true,reused:true};
    const f = githubTransport(runtime);
    const response = await f("https://api.github.com/graphql", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}", variables: { id: pr.node_id } }) });
    const body = await response.json() as {errors?:unknown}; requireValue(response.ok && !body.errors, "Ready conversion failed; inspect GitHub and retry. No merge was attempted.");
    const after=await candidate(head);assertPublished();requireValue(after?.number===pr.number&&after.draft===false,"Remote PR changed during ready conversion; inspect GitHub before resuming.");
    return {number:pr.number,revision:head,ready:true,reused:false};
  }
  assertRemote(root,p,runtime,remote);
  git(root,"push","--no-follow-tags","--recurse-submodules=no",remote.pushUrl,`${head}:refs/heads/${task.canonicalBranch}`);
  assertPublished();
  const adapter=await createLocalPullRequestLifecycleAdapter(root,{...g,fetchImpl:async(url,init)=>{
    assertEvidence();
    if(init.method==="POST"||init.method==="PATCH") {
      const pr=await candidate(head);assertPublished();
      requireValue(init.method==="POST"?!pr:pr?.number===Number(new URL(url).pathname.split("/").at(-1)),"Canonical PR changed while preparing publication.","PR_CONFLICT");
    }
    return g.fetchImpl(url,init);
  }});
  const result=await adapter.ensurePullRequest({taskId:s.taskId,childIssueNumber:s.issueNumber,parentIssueNumber:1,expectedHead:task.canonicalBranch,base:p.integrationTarget});
  const after=await candidate(head);assertPublished();requireValue(after?.number===result.number,"Canonical PR changed during publication.");
  return result;
}
