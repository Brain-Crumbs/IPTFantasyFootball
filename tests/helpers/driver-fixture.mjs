import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runCli} from '../../dist/cli/core.js';
export const sourceRoot=fileURLToPath(new URL('../..',import.meta.url));
export const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export const put=(root,path,bytes)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),typeof bytes==='string'?bytes:JSON.stringify(bytes,null,2));};
export const get=(root,path)=>JSON.parse(readFileSync(join(root,path),'utf8'));
export const pause=()=>new Promise(resolve=>setTimeout(resolve,650));
export function markdown(task='DEMO-001',dependencies=[],contracts=task==='DEMO-001'?['control-plane.cli-shell']:[]){
 return `# Implement ${task}\nTask ID: ${task}\nCanonical branch: feature/${task.toLowerCase()}\nIssue: #${task.endsWith('001')?101:102}\n\n## Objective\nDeliver the requested marker through the manual workflow.\n\n${Object.entries({'In scope':['marker.txt'],'Out of scope':['No other product changes.'],'Dependencies':dependencies,'Allowed paths':['marker.txt'],'Requirements':[`${task}-R1`],'Acceptance criteria':['Marker matches the requested value.'],'Validation plan':['npm run build','npm test'],'Affected contracts':contracts,'Required review roles':task==='DEMO-001'?['Developer','QA','Architect','UAT/Product','MergeController']:['Developer','UAT/Product','MergeController']}).map(([heading,values])=>`## ${heading}\n${(values.length?values:['none']).map(x=>'- '+x).join('\n')}\n`).join('\n')}`;
}
export function fixture(){
 const root=mkdtempSync(join(tmpdir(),'driver space '));
 cpSync(join(sourceRoot,'schemas'),join(root,'schemas'),{recursive:true});
 cpSync(join(sourceRoot,'contracts/cli-shell'),join(root,'contracts/cli-shell'),{recursive:true});
 for(const task of ['DEMO-001','DEMO-002'])put(root,`requirements/${task}.json`,{schemaId:'ipt.requirement',schemaVersion:'1.0.0',requirementId:`${task}-R1`,taskId:task,statement:'Marker matches requested value.',acceptanceCriteria:['Marker is delivered.'],sourceRefs:['fixture']});
 put(root,'.gitignore','.agent/\n');put(root,'.gitattributes','* text=auto eol=lf\n');
 put(root,'package.json',{name:'driver-isolated-consumer',private:true,type:'module',scripts:{build:'node --check verify.mjs',test:'node verify.mjs'}});
 put(root,'verify.mjs',`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('marker.txt','utf8'),'delivered\\n');\n`);
 git(root,'init','-b','main');git(root,'config','user.name','Driver fixture');git(root,'config','user.email','driver@example.invalid');
 git(root,'remote','add','origin','https://github.com/fixture-owner/fixture-repo.git');git(root,'add','.');git(root,'commit','-m','Seed consumer requirements and contract');
 const bare=join(root,'.agent','remote.git');mkdirSync(bare,{recursive:true});git(root,'init','--bare',bare);
 git(root,'config',`url.${pathToFileURL(bare).href}.insteadOf`,'https://github.com/fixture-owner/fixture-repo.git');
 const remote={pr:null,ci:'success',merges:0,calls:[],failTransport:false};
 const fetchImpl=async(url,init)=>{
  if(remote.failTransport)throw new Error('fixture-not-secret');
  const u=new URL(url),body=init.body?JSON.parse(init.body):null,method=init.method??'GET';remote.calls.push({url,method,body});
  const ok=data=>({ok:true,status:200,json:async()=>structuredClone(data)});
  if(u.pathname==='/graphql'){assert.match(body.query,/markPullRequestReadyForReview/);remote.pr.draft=false;return ok({data:{pullRequest:{id:'fixture-pr'}}});}
  assert.ok(u.pathname.startsWith('/repos/fixture-owner/fixture-repo/'));
  const branch=git(root,'branch','--show-current');
  const pr=()=>remote.pr?{...remote.pr,head:{ref:branch,sha:remote.pr.originalHead??git(root,'rev-parse','HEAD'),repo:{full_name:'fixture-owner/fixture-repo'}},base:{ref:'main',repo:{full_name:'fixture-owner/fixture-repo'}}}:null;
  if(u.pathname.endsWith('/check-runs'))return ok({check_runs:[{name:u.searchParams.get('check_name'),status:remote.ci==='pending'?'in_progress':'completed',conclusion:remote.ci==='pending'?null:remote.ci,started_at:new Date().toISOString()}]});
  if(u.pathname.endsWith('/pulls')&&method==='POST'){assert.equal(body.draft,true);remote.pr={number:1,node_id:'fixture-pr',html_url:'https://github.com/fixture-owner/fixture-repo/pull/1',title:body.title,body:body.body,state:'open',draft:true,merged:false,merged_at:null,merge_commit_sha:null};return ok(pr());}
  if(u.pathname.endsWith('/pulls')&&method==='GET')return ok(remote.pr&&(u.searchParams.get('state')!=='open'||remote.pr.state==='open')?[pr()]:[]);
  if(u.pathname.endsWith('/pulls/1')&&method==='PATCH'){Object.assign(remote.pr,body);return ok(pr());}
  if(u.pathname.endsWith('/pulls/1')&&method==='GET')return ok(pr());
  if(u.pathname.endsWith('/pulls/1/merge')&&method==='PUT'){
   assert.equal(remote.pr.draft,false);assert.equal(body.sha,git(root,'rev-parse','HEAD'));remote.merges++;
   remote.pr.originalHead=body.sha;git(root,'switch','main');git(root,'merge','--no-ff',branch,'-m','Fixture controlled merge');git(root,'switch',branch);
   Object.assign(remote.pr,{state:'closed',merged:true,merged_at:new Date().toISOString(),merge_commit_sha:git(root,'rev-parse','main')});
   if(remote.loseMergeResponse)throw new Error('simulated lost response after merge');
   return ok({merged:true,sha:remote.pr.merge_commit_sha,message:'Fixture merge'});
  }
  throw new Error(`Unexpected fixture request ${method} ${url}`);
 };
 const runtime={fetchImpl,token:'fixture-not-secret'};
 const cli=async(...args)=>{const result=await runCli(['--json','orchestrate',...args],{repositoryRoot:root,driverRuntime:runtime});return {result,envelope:JSON.parse(result.stdout)};};
 const init=()=>cli('init','--repository','fixture-owner/fixture-repo','--base','main','--checks','Build and test (Node),Schema and contract validation (Python)','--actor-prefix','operator','--developer-tools','read_file,write_file,git_commit','--review-tools','read_file,run_test','--enforce-policies','externally');
 return {root,remote,runtime,cli,init};
}
export function response(packet,outcome='PASS'){
 const details=packet.role==='QA'?{acceptanceCriteriaScenarios:['marker exact bytes'],regressionNegativeCaseCoverage:['wrong marker rejected']}:packet.role==='Architect'?{affectedContractsModules:['control-plane.cli-shell'],dependencyConsumerSurfaces:['consumer task'],semanticCompatibilityAssessment:'Marker adds no control-plane capability.',invariantDependencyRuleAssessment:'Existing gates retain authority.'}:packet.role==='UAT/Product'?{intendedOutcomesScenarios:['operator delivers selected task'],observedBehavior:['marker matches requested value']}: {summary:'Fixture developer implemented marker.'};
 return {schemaId:'ipt.local-agent-result',schemaVersion:'1.0.0',...packet.resultBinding,status:'COMPLETED',result:{runId:packet.runId,providerId:packet.providerId,taskId:packet.taskId,role:packet.role,revisionIdentity:packet.revisionIdentity,outcome,details,findings:outcome==='PASS'?[]:[{findingId:'fixture-failure',severity:'HIGH',observed:'Fixture rejection',expected:'Marker accepted'}],evidenceRefs:[],occurredAt:new Date().toISOString(),...(outcome==='PASS'?{}:{nonPass:{reason:'Fixture rejection',remediation:'Use legal rework.'}})}};
}
