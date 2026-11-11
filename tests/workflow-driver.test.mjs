import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,readFileSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture,markdown,put,get,git,pause,response,sourceRoot} from './helpers/driver-fixture.mjs';
import {mapMarkdown,loadProfile,loadSession} from '../dist/workflow-driver/intake.js';
import {scan as scanInbox} from '../dist/workflow-driver/inbox.js';

async function prepared(f,task='DEMO-001',dependencies=[]){put(f.root,'issue.md',markdown(task,dependencies));git(f.root,'add','issue.md');git(f.root,'commit','-m','Selected issue input');const r=await f.cli('prepare','--issue-file','issue.md');assert.equal(r.envelope.ok,true,JSON.stringify(r.envelope));assert.ok(r.envelope.data.sessionId,JSON.stringify(r.envelope));return r.envelope.data.sessionId;}
async function scan(f,s){await f.cli('watch',s,'--once');await pause();return (await f.cli('watch',s,'--once')).envelope.data.session;}
const packet=(f,s)=>get(f.root,`.agent/driver/exchange/${s.pendingPacket}.packet.json`);

test('CLI setup, stdin/folder intake, clarification, identities and explicit dependency selection',async()=>{
 const f=fixture();assert.equal((await f.init()).envelope.ok,true);
 const cli=join(sourceRoot,'dist/cli/cli.js');
 const stdin=spawnSync(process.execPath,[cli,'--json','orchestrate','prepare','--stdin'],{cwd:f.root,input:markdown(),encoding:'utf8'});
 assert.equal(stdin.status,0,stdin.stdout);const intake=JSON.parse(stdin.stdout).data;assert.ok(intake.sessionId);
 const original=get(f.root,`.agent/driver/sessions/${intake.sessionId}.json`);
 put(f.root,'.agent/driver/inbox/issues/another.md',markdown('DEMO-002',['DEMO-001']));
 await f.cli('watch','--once');await pause();const folder=await f.cli('watch','--once');assert.ok(folder.envelope.data.receipts.some(r=>r.sessionId));
 const second=folder.envelope.data.receipts.find(r=>r.sessionId).sessionId;
 const rejected=(await f.cli('run',second)).envelope.data.session;assert.equal(rejected.status,'WAITING');assert.match(get(f.root,`.agent/driver/outbound/${rejected.diagnosticId}.diagnostic.json`).message,/not the next eligible/);
 let s=(await f.cli('run',intake.sessionId)).envelope.data.session;assert.ok(s.pendingPacket);const p=packet(f,s);
 for(let i=0;i<4;i++)s=(await f.cli('resume',s.sessionId)).envelope.data.session;
 assert.deepEqual(s.request,original.request);assert.equal(s.pendingPacket,p.packetId);
 const journals=readdirSync(join(f.root,'.agent/state/orchestration')).filter(x=>x.endsWith('.run.json'));assert.equal(get(f.root,`.agent/state/orchestration/${journals[0]}`).attempts['developer-agent'],undefined);
 const handoff=get(f.root,`.agent/driver/outbound/${p.packetId}.handoff.json`);assert.match(JSON.stringify(handoff.responseSchema),/ipt.local-agent-result/);assert.match(handoff.responseTemplate.result.outcome,/PASS, FAIL or BLOCKED/);
});

test('actual manual response inbox advances real gates with nonempty requirements/contracts; immutable failures and linked rework',async()=>{
 const f=fixture();await f.init();const sid=await prepared(f);let s=(await f.cli('run',sid)).envelope.data.session;
 const first=packet(f,s);assert.ok(first.contextPackage.artifacts.some(x=>x.kind==='requirement'));assert.ok(first.contextPackage.artifacts.some(x=>x.kind==='contract'));
 put(f.root,'marker.txt','delivered\n');git(f.root,'add','marker.txt');git(f.root,'commit','-m','Implement selected marker');
 put(f.root,'.agent/driver/inbox/responses/arbitrary.json',response(first));s=await scan(f,sid);assert.ok(s.pendingPacket,JSON.stringify(s));assert.equal(packet(f,s).role,'QA');
 const qa=packet(f,s);put(f.root,'.agent/driver/inbox/responses/reject.json',response(qa,'FAIL'));s=await scan(f,sid);
 assert.equal(get(f.root,'.agent/state/lifecycle/DEMO-001.lifecycle.json').currentState,'REWORK_REQUIRED');
 const accepted=readFileSync(join(f.root,`.agent/driver/exchange/${qa.packetId}.result.json`),'utf8');
 const next=(await f.cli('rework',sid)).envelope;assert.equal(next.ok,true,JSON.stringify(next));assert.equal(next.data.predecessor,sid);
 s=(await f.cli('run',next.data.sessionId)).envelope.data.session;assert.equal(packet(f,s).role,'Developer');assert.notEqual(packet(f,s).runId,first.runId);
 assert.equal(readFileSync(join(f.root,`.agent/driver/exchange/${qa.packetId}.result.json`),'utf8'),accepted);
});

test('partial, malformed, conflicting and wrong-binding drops preserve pending work and allow correction',async()=>{
 const f=fixture();await f.init();const sid=await prepared(f);let s=(await f.cli('run',sid)).envelope.data.session;const p=packet(f,s);
 put(f.root,'.agent/driver/inbox/responses/slow.json','{"schemaId":');s=await scan(f,sid);assert.equal(s.pendingPacket,p.packetId);
 const bad=response(p);bad.runId='wrong';put(f.root,'.agent/driver/inbox/responses/slow.json',bad);s=await scan(f,sid);assert.equal(s.pendingPacket,p.packetId);
 put(f.root,'marker.txt','delivered\n');git(f.root,'add','marker.txt');git(f.root,'commit','-m','Deliver marker');put(f.root,'.agent/driver/inbox/responses/slow.json',response(p));s=await scan(f,sid);assert.equal(packet(f,s).role,'QA');
 const receipts=readdirSync(join(f.root,'.agent/driver/archive')).filter(x=>x.endsWith('.receipt.json')).map(x=>get(f.root,`.agent/driver/archive/${x}`));assert.equal(receipts.filter(x=>x.status==='REJECTED').length,2);assert.equal(receipts.filter(x=>x.status==='ACCEPTED').length,1);
});

test('contract-bearing CLI flow uses draft, exact CI, explicit ready/merge, and reconciles a lost merge response',async()=>{
 const f=fixture();assert.equal((await f.init()).envelope.ok,true);
 const sid=await prepared(f);const second=await prepared(f,'DEMO-002',['DEMO-001']);
 let s=(await f.cli('run',sid)).envelope.data.session;
 for(const role of ['Developer','QA','Architect','UAT/Product']){
  const p=packet(f,s);assert.equal(p.role,role);
  if(role==='Developer'){put(f.root,'marker.txt','delivered\n');git(f.root,'add','marker.txt');git(f.root,'commit','-m','Implement selected marker');}
  if(role==='UAT/Product')assert.ok(!p.contextPackage.artifacts.some(x=>x.kind==='contract'||x.kind==='requirement'),'UAT receives the gate-filtered context even when the task has contracts');
  put(f.root,`.agent/driver/inbox/responses/${p.packetId}.json`,response(p));s=await scan(f,sid);
 }
 assert.equal(get(f.root,'.agent/state/lifecycle/DEMO-001.lifecycle.json').currentState,'MERGE_READY');
 const premature=await f.cli('ready',sid);assert.equal(premature.envelope.ok,false);assert.equal(f.remote.pr,null);
 const pub=await f.cli('publish',sid);assert.equal(pub.envelope.ok,true,JSON.stringify(pub.envelope));assert.equal(f.remote.pr.draft,true);
 const ready=await f.cli('ready',sid);assert.equal(ready.envelope.ok,true,JSON.stringify(ready.envelope));assert.equal(f.remote.pr.draft,false);
 f.remote.ci='pending';s=(await f.cli('resume',sid)).envelope.data.session;assert.equal(s.status,'WAITING');assert.equal(f.remote.merges,0);
 f.remote.ci='failure';s=(await f.cli('resume',sid)).envelope.data.session;assert.equal(s.status,'WAITING');assert.equal(f.remote.merges,0);
 f.remote.ci='success';s=(await f.cli('resume',sid)).envelope.data.session;assert.equal(s.status,'WAITING');assert.equal(f.remote.merges,0);
 f.runtime.mergeAuthorization=`fixture-owner/fixture-repo#1@${git(f.root,'rev-parse','HEAD')}`;f.remote.loseMergeResponse=true;
 s=(await f.cli('resume',sid)).envelope.data.session;assert.equal(f.remote.merges,1,JSON.stringify(s));
 s=(await f.cli('resume',sid)).envelope.data.session;assert.equal(s.status,'DONE',JSON.stringify(s));assert.equal(f.remote.merges,1);
 const completion=get(f.root,`.agent/driver/outbound/${sid}.completed.json`);assert.equal(completion.next.taskId,'DEMO-002');
 const next=await f.cli('next');assert.equal(next.envelope.data.taskId,'DEMO-002');assert.notEqual(get(f.root,`.agent/driver/sessions/${second}.json`).request.runId,s.request.runId);
 git(f.root,'switch','main');let b=(await f.cli('run',second)).envelope.data.session;const developer=packet(f,b);assert.equal(developer.taskId,'DEMO-002');
 assert.ok(developer.contextPackage.artifacts.some(x=>x.kind==='contract'),'A dependent task receives its dependency contract');
 put(f.root,'.agent/driver/inbox/responses/next.json',response(developer));b=await scan(f,second);assert.equal(packet(f,b).role,'UAT/Product');
});

test('clarification carries its original issue and permits correction of a rejected task proposal',async()=>{
 const f=fixture();await f.init();
 put(f.root,'.agent/driver/inbox/issues/incomplete.md','# Selected task\nIssue: #101\n## Objective\nDeliver the marker.\n');
 await f.cli('watch','--once');await pause();await f.cli('watch','--once');
 const outbound=join(f.root,'.agent/driver/outbound');
 const name=readdirSync(outbound).find(x=>x.endsWith('.diagnostic.json'));
 const packet=get(outbound,name);assert.equal(packet.code,'INTAKE_CLARIFICATION');
 assert.match(readFileSync(join(outbound,`${name}.md`),'utf8'),/originalIssue/);
 const bad={...packet.responseTemplate,task:{...mapMarkdown(markdown()).task,dependencies:['MISSING-001']},issueNumber:101};
 put(f.root,'.agent/driver/inbox/responses/reply.json',bad);await f.cli('watch','--once');await pause();const rejected=await f.cli('watch','--once');assert.equal(rejected.envelope.data.receipts.at(-1).status,'REJECTED');
 assert.equal(existsSync(join(f.root,'tasks/definitions/demo-001.task.json')),false);
 const good={...bad,task:mapMarkdown(markdown()).task};put(f.root,'.agent/driver/inbox/responses/reply.json',good);
 await f.cli('watch','--once');await pause();const accepted=await f.cli('watch','--once');assert.equal(accepted.envelope.data.receipts.at(-1).status,'ACCEPTED');
 assert.equal(existsSync(join(f.root,'tasks/definitions/demo-001.task.json')),true);
 assert.equal(existsSync(join(f.root,'.agent/state/lifecycle/DEMO-001.lifecycle.json')),false,'intake grants no assignment');
});

test('concurrent scans serialize and a lost receipt is reconstructed from the captured input',async()=>{
 const f=fixture();await f.init();const sid=await prepared(f);
 const runs=await Promise.all([f.cli('run',sid),f.cli('run',sid)]);assert.equal(runs.filter(x=>x.envelope.ok).length,1);
 const s=runs.find(x=>x.envelope.ok).envelope.data.session,p=packet(f,s);
 put(f.root,'marker.txt','delivered\n');git(f.root,'add','marker.txt');git(f.root,'commit','-m','Deliver marker');
 const responsePath='.agent/driver/inbox/responses/reply.json';put(f.root,responsePath,response(p));
 const profile=loadProfile(f.root),session=loadSession(f.root,profile,sid);
 await scanInbox(f.root,profile,session);await pause();const imported=await scanInbox(f.root,profile,session);
 assert.equal(imported.receipts.at(-1).status,'ACCEPTED');
 // Model the crash gap between the adapter's atomic result publication and its
 // receipt. The original inbox file need not still exist on restart.
 const receipt=imported.receipts.at(-1);unlinkSync(join(f.root,profile.paths.archive,`${receipt.inputHash}.receipt.json`));unlinkSync(join(f.root,responsePath));
 const resumed=await f.cli('resume',sid);assert.equal(resumed.envelope.data.receipts.at(-1).status,'REUSED');
 assert.equal(packet(f,resumed.envelope.data.session).role,'QA');
});

test('failed deterministic validation can reenter through quiescent authorized recovery and fresh judgment',async()=>{
 const f=fixture();await f.init();const sid=await prepared(f);let s=(await f.cli('run',sid)).envelope.data.session;
 put(f.root,'.agent/driver/inbox/responses/first.json',response(packet(f,s)));s=await scan(f,sid);
 assert.equal(get(f.root,'.agent/state/lifecycle/DEMO-001.lifecycle.json').currentState,'DEV_VALIDATION_FAILED');
 const denied=await f.cli('recover',sid,'--quiescent','--reason','fixture recovery','--authorization-ref','fixture-authority');assert.equal(denied.envelope.ok,false);
 const prior=process.env.IPT_RECOVERY_ADMIN_ACTORS;process.env.IPT_RECOVERY_ADMIN_ACTORS='operator::Developer';
 try {
  const reset=await f.cli('recover',sid,'--quiescent','--reason','fixture recovery','--authorization-ref','fixture-authority');assert.equal(reset.envelope.ok,true,JSON.stringify(reset.envelope));
 }finally{if(prior===undefined)delete process.env.IPT_RECOVERY_ADMIN_ACTORS;else process.env.IPT_RECOVERY_ADMIN_ACTORS=prior;}
 const next=(await f.cli('rework',sid)).envelope;assert.equal(next.ok,true,JSON.stringify(next));
 s=(await f.cli('run',next.data.sessionId)).envelope.data.session;
 put(f.root,'marker.txt','delivered\n');git(f.root,'add','marker.txt');git(f.root,'commit','-m','Correct failed validator input');
 put(f.root,'.agent/driver/inbox/responses/corrected.json',response(packet(f,s)));s=await scan(f,next.data.sessionId);
 assert.equal(packet(f,s).role,'QA');assert.ok(get(f.root,'.agent/state/lifecycle/DEMO-001.lifecycle.json').history.some(x=>x.toState==='DEV_VALIDATION_FAILED'));
});
