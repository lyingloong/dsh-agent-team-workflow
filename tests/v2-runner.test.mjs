import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { WorkflowRunner, executionCwd, preflightRun } from '../src/v2/runner.mjs';
import { newRunState, DEFAULT_PERMISSIONS } from '../src/v2/runtime.mjs';
import { normalizeDefinition } from '../src/v2/definition.mjs';
import { SessionStore } from '../src/v2/store.mjs';
import { fakeJobs, deferred } from './helpers/jobs.mjs';
const definition = (nodes=[{id:'a',type:'agent'}], edges=[]) => normalizeDefinition({apiVersion:2,name:'probe',entry:nodes[0].id,nodes,edges});
const done = text => ({stopReason:'completed',output:[{type:'text',text:JSON.stringify({outcome:'complete',output:text})}]});
async function setup(t, subagents, options={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'atw-runner-'));
  const jobs=fakeJobs(); const owner={id:'owner',session:{header:{cwd:path.join(dir,'original')}}};
  const ctx={get:name=>({jobs,subagents,...options.services})[name]};
  const store=new SessionStore(path.join(dir,'state'));
  const runner=new WorkflowRunner({ctx,storeFor:()=>store,agents:new Map([['owner',{agent:owner}]]),settings:options.settings ?? {}});
  t.after(async()=>{await runner.dispose();await rm(dir,{recursive:true,force:true});});
  return {dir:await realpath(dir),jobs,owner,ctx,store,runner};
}

test('effective cwd service wins over stale session header and explicit cwd is absolute', async t=>{
  const {dir,owner}=await setup(t);
  const target=path.join(dir,'intended');await mkdir(target);
  const ctx={get:name=>name==='workingDirectory'?{ensure:async()=>target}:undefined};
  assert.equal(await executionCwd(ctx,{agent:owner}),await realpath(target));
  assert.equal(await executionCwd(ctx,{agent:owner},dir),dir);
  await assert.rejects(executionCwd(ctx,{agent:owner},'.'),{code:'invalid_cwd'});
});

test('npm verification wrong-cwd preflight stops before any job or model work', async t=>{
  let calls=0;
  const env=await setup(t,{startActivation:async()=>{calls++;throw new Error('must not run');}});
  const state=newRunState({definition:definition([{id:'a',type:'agent'},{id:'verify',type:'command',config:{command:'npm test'}}],[{from:'a',to:'verify'}]),permissions:{command:{mode:'full'}},cwd:env.dir});
  await env.store.saveRun(state);
  await assert.rejects(env.runner.dispatch('owner'),{code:'invalid_command_cwd'});
  assert.equal(calls,0);assert.equal(env.jobs.records.size,0);
});

test('preflight accepts actual npm test script in the bound repository',async t=>{
  const env=await setup(t);
  await writeFile(path.join(env.dir,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
  const state=newRunState({definition:definition([{id:'verify',type:'command',config:{command:'npm test'}}]),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});
  await preflightRun(state);
});

test('dispatch is nonblocking, checkpoints progress and deduplicates concurrent owners',async t=>{
  const started=deferred(),hold=deferred();let calls=0,released=0;const cwds=[];
  const env=await setup(t,{startActivation:async spec=>{
    calls++; cwds.push(spec.request.cwd);
    if(calls===2) started.resolve();
    return {childId:`child-${calls}`,result:calls===2?hold.promise:Promise.resolve(done('a')),dispose:async()=>{released++;}};
  }});
  const state=newRunState({definition:definition([{id:'a',type:'agent'},{id:'b',type:'agent'}],[{from:'a',to:'b'}]),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});await env.store.saveRun(state);
  const [receipt,duplicate]=await Promise.all([env.runner.dispatch('owner'),env.runner.dispatch('owner')]);
  assert.equal(receipt.execution.jobId,duplicate.execution.jobId);assert.equal(env.jobs.records.size,1);
  await started.promise;
  // Start activation is checkpointed before awaiting its result; drain the write chain.
  await env.runner.active.get('owner').writes;
  const live=await env.store.latestRun();assert.equal(live.tokens[0].status,'completed');assert.equal(live.tokens[1].status,'running');
  await assert.rejects(env.runner.mutate('owner',()=>Promise.resolve()),{code:'run_active'});
  hold.resolve(done('b'));await env.jobs.settle(receipt.execution.jobId);
  const end=await env.store.latestRun();assert.equal(end.status,'done');assert.equal(end.execution.active,false);
  assert.deepEqual(cwds,[env.dir,env.dir]);assert.equal(calls,2);assert.equal(released,2);
  assert.equal(end.tokens[1].activity.childId,'child-2');
});

test('accepted job is independent of foreground wait but native cancellation is propagated',async t=>{
  const started=deferred();const hold=deferred();let released=0;
  const env=await setup(t,{startActivation:async()=>{started.resolve();return {childId:'child',result:hold.promise,dispose:async()=>{released++;}};}});
  const state=newRunState({definition:definition(),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});await env.store.saveRun(state);
  const foreground=new AbortController();
  const receipt=await env.runner.dispatch('owner',state.runId,{agent:env.owner,signal:foreground.signal});
  await started.promise;foreground.abort();
  assert.equal(env.runner.active.get('owner').controller.signal.aborted,false);
  env.jobs.kill(receipt.execution.jobId,'owner','explicit test cancel');
  const outcome=await env.jobs.settle(receipt.execution.jobId);assert.equal(outcome.status,'killed');assert.equal(released,1);
  const end=await env.store.latestRun();assert.equal(end.status,'interrupted');assert.equal(end.execution.active,false);
  const rerun=await env.runner.dispatch('owner');assert.equal(rerun.status,'interrupted');assert.equal(env.jobs.records.size,1);
});

test('cancelled admission and unavailable jobs do not start execution',async t=>{
  const env=await setup(t);
  const state=newRunState({definition:definition(),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});await env.store.saveRun(state);
  const abort=new AbortController();abort.abort();
  await assert.rejects(env.runner.dispatch('owner',undefined,{agent:env.owner,signal:abort.signal}),{name:'AbortError'});
  assert.equal(env.jobs.records.size,0);
  const runner=new WorkflowRunner({ctx:{},storeFor:()=>env.store,agents:new Map([['owner',{agent:env.owner}]])});
  await assert.rejects(runner.dispatch('owner'),{code:'jobs_unavailable'});
});

test('old unbound and orphan running runs are never replayed',async t=>{
  const env=await setup(t);
  const state=newRunState({definition:definition(),permissions:DEFAULT_PERMISSIONS});await env.store.saveRun(state);
  await assert.rejects(env.runner.dispatch('owner'),{code:'run_cwd_unbound'});
  state.cwd=env.dir;state.tokens[0].status='running';state.execution={active:true,jobId:'lost'};await env.store.saveRun(state);
  const result=await env.runner.dispatch('owner');assert.equal(result.status,'interrupted');assert.equal(result.tokens[0].error.code,'execution_unknown');assert.equal(env.jobs.records.size,0);
});

test('runner serializes control pause and deliberate continuation at safe boundaries',async t=>{
  const started=deferred(),hold=deferred();let calls=0;
  const env=await setup(t,{startActivation:async()=>{calls++;if(calls===1)started.resolve();return {childId:`child-${calls}`,result:calls===1?hold.promise:Promise.resolve(done('b')),dispose:async()=>{}};}});
  const state=newRunState({definition:definition([{id:'a',type:'agent'},{id:'b',type:'agent'}],[{from:'a',to:'b'}]),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});await env.store.saveRun(state);
  const receipt=await env.runner.dispatch('owner');await started.promise;await env.store.saveControl({continuous:false});hold.resolve(done('a'));
  await env.jobs.settle(receipt.execution.jobId);assert.equal(calls,1);assert.equal((await env.store.latestRun()).status,'paused');
  await env.store.saveControl({continuous:true});const resumed=await env.runner.dispatch('owner');await env.jobs.settle(resumed.execution.jobId);
  assert.equal(calls,2);assert.equal((await env.store.latestRun()).status,'done');
});


test('run ids cannot read or write outside their session runs directory',async t=>{
  const env=await setup(t);
  for(const id of ['../outside','../../other/runs/run-a','a/b','a\\b','']) {
    await assert.rejects(env.store.loadRun(id),{code:'invalid_run_id'});
    await assert.rejects(env.store.saveRun({runId:id}),{code:'invalid_run_id'});
  }
});

test('dispatch cannot escape disposal or caller cancellation during admission',async t=>{
  for(const kind of ['dispose','abort']) {
    const env=await setup(t);
    const state=newRunState({definition:definition(),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});await env.store.saveRun(state);
    const entered=deferred(),hold=deferred();
    env.store.latestRun=async()=>{entered.resolve();await hold.promise;return structuredClone(state);};
    const caller=new AbortController();
    const pending=env.runner.dispatch('owner',undefined,{agent:env.owner,signal:caller.signal});
    await entered.promise;
    if(kind==='dispose') await env.runner.dispose(); else caller.abort();
    hold.resolve();await assert.rejects(pending);
    assert.equal(env.jobs.records.size,0);
  }
});

test('persisted job still live in host registry is not called an orphan',async t=>{
  const env=await setup(t);const hold=deferred();
  const jobId=env.jobs.start({owner:'owner',run:()=>({cancel:()=>hold.resolve({status:'killed'}),done:hold.promise})});
  const state=newRunState({definition:definition(),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});state.execution={active:true,jobId};state.tokens[0].status='running';await env.store.saveRun(state);
  await assert.rejects(env.runner.dispatch('owner'),{code:'run_active'});
  assert.equal((await env.store.latestRun()).tokens[0].status,'running');
  hold.resolve({status:'completed'});await env.jobs.settle(jobId);
});


test('managed job continues step-budget slices until the next real wait',async t=>{
  let calls=0;
  const env=await setup(t,{startActivation:async()=>{calls++;return {childId:'child-'+calls,result:Promise.resolve(done('ok')),dispose:async()=>{}};}},{settings:{maxSteps:1}});
  const nodes=Array.from({length:5},(_,i)=>({id:'work'+i,type:'agent'}));nodes.push({id:'approval',type:'human'});
  const edges=nodes.slice(0,-1).map((node,i)=>({from:node.id,to:nodes[i+1].id}));
  const state=newRunState({definition:definition(nodes,edges),permissions:DEFAULT_PERMISSIONS,cwd:env.dir});await env.store.saveRun(state);
  const receipt=await env.runner.dispatch('owner');await env.jobs.settle(receipt.execution.jobId);
  const end=await env.store.latestRun();assert.equal(end.status,'waiting');assert.equal(calls,5);assert.equal(end.execution.active,false);
  assert.equal(end.tokens.at(-1).nodeId,'approval');assert.equal(end.tokens.at(-1).status,'waiting');
  assert.equal(env.jobs.records.size,1);
});
