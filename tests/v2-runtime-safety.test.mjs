import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDefinition } from '../src/v2/definition.mjs';
import { newRunState, run, DEFAULT_PERMISSIONS } from '../src/v2/runtime.mjs';
import { deferred } from './helpers/jobs.mjs';
const flow = (nodes, edges) => normalizeDefinition({ apiVersion: 2, name: 'safety', entry: nodes[0].id, nodes, edges });
const agent = id => ({ id, type: 'agent', config: {} });
const edge = (from, to, on = 'complete') => ({ from, to, on });
const result = output => ({ outcome: 'complete', output });

test('running and completed checkpoints precede successor work', async () => {
  const state = newRunState({ definition: flow([agent('a'),agent('b')],[edge('a','b')]), permissions: DEFAULT_PERMISSIONS });
  const snapshots = [];
  const started = deferred(), hold = deferred();
  const promise = run(state, { agent: async ({node}) => { if(node.id==='b') { started.resolve(); await hold.promise; } return result(node.id); } }, { checkpoint: async value => snapshots.push(structuredClone(value)) });
  await started.promise;
  const pending = snapshots.at(-1);
  assert.equal(pending.tokens[0].status, 'completed');
  assert.equal(pending.tokens[1].status, 'running');
  assert.equal(pending.context.nodes.a.output, 'a');
  hold.resolve(); await promise;
  assert.equal(state.status, 'done');
});

test('checkpoint failure before admission prevents all executor side effects', async () => {
  const state = newRunState({ definition: flow([agent('a')], []), permissions: DEFAULT_PERMISSIONS });
  let calls = 0;
  await assert.rejects(run(state, { agent: async () => { calls++; return result(null); } }, { checkpoint: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(calls, 0);
});

test('repair cycles stop after a failure budget and retain last verify evidence', async () => {
  const definition = flow([agent('implement'), {id:'verify', type:'command',config:{command:'test',maxFailures:3}}, agent('pr')], [edge('implement','verify'),edge('verify','implement','fail'),edge('verify','pr')]);
  const state = newRunState({ definition, permissions:{command:{mode:'full'},http:{mode:'deny'}} });
  let repairs=0, prs=0;
  await run(state, { agent: async ({node}) => { if(node.id==='pr') prs++; else repairs++; return result(null); }, command: async () => ({outcome:'fail',output:{code:1,stderr:'cannot find package.json'}}) });
  assert.equal(state.status, 'failed');
  assert.equal(repairs,3); assert.equal(prs,0);
  assert.equal(state.tokens.at(-1).error.code, 'failure_budget_exhausted');
  assert.equal(state.tokens.at(-1).output.stderr, 'cannot find package.json');
});

test('step budget yields without failing or re-executing completed nodes', async () => {
  const state = newRunState({definition:flow([agent('a'),agent('b'),agent('c')],[edge('a','b'),edge('b','c')]),permissions:DEFAULT_PERMISSIONS});
  const calls=[]; const executors={agent:async({node})=>{calls.push(node.id);return result(null);}};
  await run(state,executors,{maxSteps:1}); assert.equal(state.status,'paused'); assert.equal(state.pauseReason,'step_budget');
  await run(state,executors,{maxSteps:1}); assert.equal(state.status,'paused');
  await run(state,executors,{maxSteps:1}); assert.equal(state.status,'done'); assert.deepEqual(calls,['a','b','c']);
});

test('failed and interrupted runs never secretly execute ready tokens', async () => {
  for(const status of ['failed','interrupted']) {
    const state=newRunState({definition:flow([agent('a')],[]),permissions:DEFAULT_PERMISSIONS}); state.status=status;
    let calls=0; await run(state,{agent:async()=>{calls++;return result(null);}});
    assert.equal(calls,0); assert.equal(state.status,status);
  }
});

test('orphan running token is reported as unknown, never replayed', async () => {
  const state=newRunState({definition:flow([agent('a')],[]),permissions:DEFAULT_PERMISSIONS}); state.tokens[0].status='running';
  let calls=0; await run(state,{agent:async()=>{calls++;return result(null);}});
  assert.equal(calls,0); assert.equal(state.status,'interrupted'); assert.equal(state.tokens[0].error.code,'execution_unknown');
});

test('live control pauses a repair chain at a safe boundary without a gate', async () => {
  const state=newRunState({definition:flow([agent('a'),agent('b')],[edge('a','b')]),permissions:DEFAULT_PERMISSIONS});
  const entered=deferred(), hold=deferred(); const control={continuous:true}; const calls=[];
  const executors={agent:async({node})=>{calls.push(node.id);if(node.id==='a'){entered.resolve();await hold.promise;}return result(null);}};
  const pending=run(state,executors,{control:async()=>control}); await entered.promise;
  control.continuous=false; hold.resolve(); await pending;
  assert.deepEqual(calls,['a']); assert.equal(state.status,'paused'); assert.equal(state.tokens[1].status,'ready');
  control.continuous=true; await run(state,executors,{control:async()=>control}); assert.deepEqual(calls,['a','b']); assert.equal(state.status,'done');
});

test('cancellation preserves completed nodes and does not select a successor', async () => {
  const controller=new AbortController();
  const state=newRunState({definition:flow([agent('a'),agent('b')],[edge('a','b')]),permissions:DEFAULT_PERMISSIONS});
  let calls=0;
  await run(state,{agent:async()=>{calls++; controller.abort(); throw Object.assign(new Error('cancelled'),{code:'execution_aborted'});}},{signal:controller.signal});
  assert.equal(calls,1); assert.equal(state.status,'interrupted'); assert.equal(state.tokens[0].status,'interrupted');
  await run(state,{agent:async()=>{calls++;return result(null);}}); assert.equal(calls,1);
});

test('fanout follow-up executes exactly its stored input snapshot and keeps item', async () => {
  const definition=flow([{id:'split',type:'fanout',config:{items:'$input.items',target:'work',join:'join'}},{...agent('work'),inputs:{item:'$item'}},{...agent('follow'),inputs:{parent:'$nodes.work.output',item:'$item'}},{id:'join',type:'join',config:{mode:'all'}}],[edge('work','follow')]);
  const state=newRunState({definition,permissions:DEFAULT_PERMISSIONS,input:{items:['A','B']}});
  const seen=[];
  await run(state,{agent:async({node,input,token})=>{assert.deepEqual(input,token.input); if(node.id==='follow')seen.push(input);return result(input.item);}});
  assert.deepEqual(seen,[{parent:'A',item:'A'},{parent:'B',item:'B'}]);
});

test('injected clock governs node creation and completion', async () => {
  const at='2030-01-01T00:00:00.000Z';
  const state=newRunState({definition:flow([agent('a'),agent('b')],[edge('a','b')]),permissions:DEFAULT_PERMISSIONS,now:at});
  await run(state,{agent:async()=>result(null)},{now:()=>at});
  assert.ok(state.tokens.every(token=>token.createdAt===at&&token.updatedAt===at));
});


test('explicit cycle boundary consumes initial request once and isolates feedback', async () => {
  const gate={id:'gate',type:'gate',config:{newCycle:true,consumeInput:['source','requirement']}};
  const definition=flow([gate,{...agent('work'),inputs:{request:'$input.requirement',goal:'$input.goal',review:'$nodes.review.output'}},{id:'review',type:'agent',config:{outcomes:['again','done']}},{id:'human',type:'human'}],[edge('gate','work'),edge('work','review'),edge('review','gate','again'),edge('review','human','done')]);
  const state=newRunState({definition,permissions:DEFAULT_PERMISSIONS,input:{source:'user',requirement:{id:'A'},goal:'keep'}});
  const seen=[];let rounds=0;
  await run(state,{agent:async({node,input})=>{
    if(node.id==='work'){seen.push(structuredClone(input));return result(null);}
    rounds++;return {outcome:rounds===1?'again':'done',output:{note:'previous item'}};
  }});
  assert.deepEqual(seen[0].request,{id:'A'});
  assert.equal(seen[1].request,undefined);assert.equal(seen[1].goal,'keep');assert.equal(seen[1].review,undefined);
  assert.deepEqual(state.initialInput.requirement,{id:'A'});assert.equal(state.context.cycle.index,2);
});

test('nested progress is attached before child work and persists child activity',async()=>{
  const nested=flow([agent('inside')],[]);
  const state=newRunState({definition:flow([{id:'nested',type:'subworkflow',config:{definition:nested}}],[]),permissions:DEFAULT_PERMISSIONS});
  const entered=deferred(),hold=deferred();const snapshots=[];
  const pending=run(state,{agent:async()=>{entered.resolve();await hold.promise;return result('ok');}},{checkpoint:async value=>snapshots.push(structuredClone(value))});
  await entered.promise;
  assert.equal(snapshots.at(-1).tokens[0].childRun.tokens[0].status,'running');
  hold.resolve();await pending;assert.equal(state.status,'done');
});
