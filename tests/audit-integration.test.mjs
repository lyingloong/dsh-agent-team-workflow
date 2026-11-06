import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WorkflowRunner, preflightRun } from '../src/v2/runner.mjs';
import { SessionStore } from '../src/v2/store.mjs';
import { normalizeDefinition } from '../src/v2/definition.mjs';
import { createExecutors, parseCommandResult, parseAgentText } from '../src/v2/executors.mjs';
import { installWebApi, ROUTE_PREFIX } from '../src/v2/web-api.mjs';
import { fakeJobs, deferred } from './helpers/jobs.mjs';
test('plain text and missing outcomes cannot silently pass even single-outcome agents',()=>{
  for (const value of ['I could not complete the task', '{}', 'null', '[]']) assert.throws(()=>parseAgentText(value,{outcomes:['complete']}),e=>e.code==='invalid_agent_output');
});
test('native command cancellation drains shell descendants before returning',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aw-cancel-audit-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5}));
  await writeFile(path.join(root,'child.mjs'),`import fs from 'node:fs'; fs.writeFileSync('started','yes'); setTimeout(()=>fs.writeFileSync('late-write','bad'),600);`);
  const controller=new AbortController();
  const ex=createExecutors({ctx:{get:()=>undefined},exec:{signal:controller.signal},cwd:root});
  const task=ex.command({node:{id:'child',config:{command:'node child.mjs'}},input:{}}); task.catch(()=>{});
  await until(async()=>{try{await stat(path.join(root,'started'));return true;}catch{return false;}});
  controller.abort(Object.assign(new Error('audit stop'),{code:'execution_aborted'}));
  await assert.rejects(task,e=>e.code==='execution_aborted');await delay(800);
  await assert.rejects(stat(path.join(root,'late-write')),{code:'ENOENT'});
});
test('failed initial native-job checkpoint releases admission and does not leak a job',async t=>{
  const f=await fixture(t,graph([{id:'ask',type:'human'}]),async()=>{});
  const state=await f.runner.startRun(f.agent.id,{input:{},exec:{agent:f.agent}});
  const save=f.store.saveRun.bind(f.store);f.store.saveRun=async s=>{if(s.execution?.mounted)throw Error('injected save failure');return save(s);};
  await assert.rejects(f.runner.dispatch(f.agent.id,state.runId,{agent:f.agent}),/injected save failure/);
  await until(()=>f.jobs.records.values().next().value.status==='failed');assert.equal(f.runner.active.size,0);
});
test('older pending causal-snapshot shapes are rejected without migration or execution',async t=>{
  const f=await fixture(t,graph([{id:'ask',type:'human'}]),async()=>{throw Error('must not execute');});
  const state=await f.runner.startRun(f.agent.id,{input:{},exec:{agent:f.agent}});delete state.tokens[0].results;await f.store.saveRun(state);
  await assert.rejects(f.runner.dispatch(f.agent.id,state.runId,{agent:f.agent}),e=>e.code==='unsupported_run_state');
  assert.equal(f.jobs.records.size,0);assert.equal((await f.store.loadRun(state.runId)).tokens[0].results,undefined);
});
test('parked jobs do not poll or rewrite idle checkpoints',async t=>{
  const f=await fixture(t,graph([{id:'ask',type:'human'}]),async()=>{});let writes=0;
  const save=f.store.saveRun.bind(f.store);f.store.saveRun=s=>{writes++;return save(s);};await f.start();
  await until(async()=> (await f.store.latestRun()).status==='waiting');await delay(100);const before=writes;
  await delay(2200);assert.equal(writes,before,'a persistent idle job parks on notifications');
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<1000;i++) { if(await fn()) return; await delay(5); } assert.fail('condition timed out'); }
const graph = (nodes, edges=[], other={}) => normalizeDefinition({ apiVersion:2, name:'audit', nodes, edges, ...other });
async function fixture(t, definition, activation) {
  const root=await mkdtemp(path.join(os.tmpdir(),'aw-audit-integration-'));
  const store=new SessionStore(path.join(root,'store')), jobs=fakeJobs(), agent={id:'audit-owner'};
  const ctx={ get: key => ({ jobs, agents:{get:()=>agent}, workingDirectory:{ensure:async()=>root}, subagents:{startActivation:activation} })[key] };
  const runner=new WorkflowRunner({ctx,storeFor:()=>store,settings:{maxSteps:40}});
  await store.saveDefinition({definition});
  t.after(async()=>{ await runner.dispose(); await rm(root,{recursive:true,force:true,maxRetries:5}); });
  return {root,store,jobs,agent,ctx,runner, start:async()=>{const s=await runner.startRun(agent.id,{input:{},exec:{agent}});await runner.dispatch(agent.id,s.runId,{agent});return s;}};
}
function result(outcome='complete') { return {stopReason:'completed', output:[{type:'text',text:JSON.stringify({outcome,output:{}})}]}; }
for (const mode of ['global','node']) test(`live ${mode} switch blocks successor admissions before the current slice ends`, async t=>{
  const gate=deferred(), entered=deferred(); let calls=0;
  const f=await fixture(t,graph([{id:'first',type:'agent'},{id:'second',type:'agent'}],[{from:'first',to:'second'}]),async()=>{
    calls++; if(calls===1) entered.resolve();
    return {childId:'child',result:calls===1?gate.promise.then(()=>result()):Promise.resolve(result()),dispose:async()=>{}};
  });
  t.after(()=>gate.resolve()); await f.start(); await entered.promise;
  await f.runner.control(f.agent.id,mode==='global'?{continuous:false}:{nodeId:'second',enabled:false});
  gate.resolve(); await until(()=>f.runner.active.get(f.agent.id).state.tokens.some(t=>t.nodeId==='second') || calls>1);
  await delay(60); assert.equal(calls,1,'a disabled successor must not be admitted');
  await f.runner.control(f.agent.id,mode==='global'?{continuous:true}:{nodeId:'second',enabled:true});
  await until(()=>calls===2);
});
test('root command preflight runs even when node cwd is omitted', async t=>{
  const f=await fixture(t,graph([{id:'verify',type:'command',config:{command:'npm test'}}]),async()=>{});
  await assert.rejects(preflightRun({cwd:f.root,definition:graph([{id:'verify',type:'command',config:{command:'npm test'}}])}),e=>e.code==='invalid_command_cwd');
});
test('parked execution flags agree between live memory and disk',async t=>{
  const f=await fixture(t,graph([{id:'ask',type:'human'}]),async()=>{});await f.start();
  await until(async()=> (await f.store.latestRun()).status==='waiting');
  await delay(60); // allow the running -> waiting checkpoint and scheduler drain to settle
  const live=f.runner.active.get(f.agent.id).state, disk=await f.store.latestRun();
  assert.equal(live.execution.active,false);assert.equal(disk.execution.active,false);
  assert.equal(live.execution.mounted,true);
});
test('existing live host owner prevents a second runner from taking its persisted run',async t=>{
  const f=await fixture(t,graph([{id:'ask',type:'human'}]),async()=>{});await f.start();
  await until(async()=> (await f.store.latestRun()).status==='waiting');
  const other=new WorkflowRunner({ctx:f.ctx,storeFor:()=>f.store});t.after(()=>other.dispose());
  await assert.rejects(other.dispatch(f.agent.id,undefined,{agent:f.agent}),e=>e.code==='run_active');
  assert.equal(f.jobs.records.size,1);
});
test('interrupted Human state cannot be decided or revived by control',async t=>{
  const f=await fixture(t,graph([{id:'ask',type:'human'},{id:'next',type:'agent'}],[{from:'ask',to:'next',on:'approve'}]),async()=>{throw Error('must not execute');});await f.start();
  await until(async()=> (await f.store.latestRun()).status==='waiting');
  const token=(await f.store.latestRun()).tokens[0];await f.runner.stop(f.agent.id);await until(()=>!f.runner.active.size);
  await assert.rejects(f.runner.decide(f.agent.id,{tokenId:token.id,outcome:'approve'}),e=>e.code==='run_not_replayable');
  await f.runner.control(f.agent.id,{continuous:false}); await f.runner.control(f.agent.id,{continuous:true});
  assert.equal((await f.store.latestRun()).status,'interrupted');assert.equal(f.jobs.records.size,1);
});
test('protocol rejects ambiguous command results and trailing diagnostic text',()=>{
  for (const text of ['{"outcome":"pass"}\n{"outcome":"fail"}', '{"outcome":"pass"} late failure']) assert.throws(()=>parseCommandResult(text),e=>e.code==='invalid_command_output');
});
for(const reason of ['max-tokens','refusal']) test(`${reason} does not fall back to another model`,async()=>{
  let calls=0;
  const ex=createExecutors({ctx:{get:()=>({startActivation:async()=>{calls++;return {childId:'c',result:Promise.resolve({stopReason:reason,output:[]}),dispose:async()=>{}};}})},exec:{agent:{id:'a'},signal:new AbortController().signal},cwd:process.cwd()});
  await assert.rejects(ex.agent({node:{id:'a',config:{models:[{provider:'p',model:'a'},{provider:'p',model:'b'}],outcomes:['complete']}},definition:{name:'audit'},token:{},input:{},context:{}}));
  assert.equal(calls,1);
});
test('main board endpoint fails closed without Connection authentication', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aw-api-audit-'));const routes=new Map();
  const api=installWebApi({dataRoot:root,ctx:{get:k=>k==='webServer'?{register:r=>routes.set(r.path,r.handler)}:undefined}});
  t.after(async()=>{await api.closeBoardServer();await rm(root,{recursive:true,force:true});});
  const res={writeHead(status){this.status=status;},end(body){this.body=body;}};
  await routes.get(`${ROUTE_PREFIX}/api/board-url`)({url:`${ROUTE_PREFIX}/api/board-url?session=a`,headers:{}},res);
  assert.equal(res.status,503);assert.equal(String(res.body).includes('token='),false);
});
test('session traversal is rejected on the private API',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aw-api-audit-'));const api=installWebApi({dataRoot:root,ctx:{get:()=>undefined}});
  t.after(async()=>{await api.closeBoardServer();await rm(root,{recursive:true,force:true});});
  await api.boardReady;const u=new URL(api.boardUrl('a'));u.pathname=`${ROUTE_PREFIX}/api/state`;u.searchParams.set('session','..');
  assert.equal((await fetch(u)).status,400);
  u.searchParams.set('session','other');assert.equal((await fetch(u)).status,401,'one board token cannot read another session');
  u.searchParams.set('session','a');assert.equal((await fetch(u,{headers:{origin:'http://attacker.invalid'}})).status,403);
  u.pathname=`${ROUTE_PREFIX}/api/control`;u.searchParams.delete('session');
  assert.equal((await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:'other',continuous:false})})).status,401,'POST session is checked against its token too');
});
test('HTTP redirects cannot escape the host permission grant',async t=>{
  let leaked=0;
  const target=createServer((q,s)=>{leaked++;s.end('secret destination');}); await new Promise(r=>target.listen(0,'127.0.0.1',r));
  const source=createServer((q,s)=>{s.writeHead(302,{location:`http://127.0.0.1:${target.address().port}/`});s.end();});await new Promise(r=>source.listen(0,'127.0.0.1',r));
  t.after(()=>{source.closeAllConnections();target.closeAllConnections();source.close();target.close();});
  const host=`127.0.0.1:${source.address().port}`;
  const ex=createExecutors({ctx:{get:()=>undefined},exec:{signal:new AbortController().signal},cwd:process.cwd()});
  await assert.rejects(ex.http({node:{id:'get',config:{url:`http://${host}/`}},permissions:{http:{mode:'allowlist',allow:[host]}}}),e=>e.code==='permission_denied');
  assert.equal(leaked,0);
});
