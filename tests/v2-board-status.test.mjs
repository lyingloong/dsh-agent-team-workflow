import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../src/v2/board.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('board script compiles after job/progress changes',()=>{
  assert.doesNotThrow(()=>new vm.Script(script));
});

function render(run) {
  const start=script.indexOf('  function renderRun()');
  const end=script.indexOf('  function renderHuman()',start);
  const elements=Object.fromEntries(['runHint','runSummary','runBtn','stopBtn'].map(key=>[key,{}]));
  const fn=new Function('state','$','esc','STATUS','TOKEN','busy','renderHuman',script.slice(start,end)+'; return renderRun;');
  fn({run},id=>elements[id],value=>String(value??''),{}, {},false,()=>{})();
  return elements;
}

test('board uses execution ownership rather than running status to enable Continue',()=>{
  const base={runId:'run-a',status:'running',cwd:'/repo',tokens:[],waiting:[],current:{nodeId:'plan',status:'ready'},jobId:'',execution:{active:false}};
  const ready=render(base);assert.equal(ready.runBtn.disabled,false);assert.equal(ready.stopBtn.disabled,true);
  const active=render({...base,jobId:'workflow-1',execution:{active:true}});assert.equal(active.runBtn.disabled,true);assert.equal(active.stopBtn.disabled,false);
});

test('board displays bound cwd and actual run error and refuses failed replay',()=>{
  const elements=render({runId:'run-a',status:'failed',cwd:'/bound/repo',jobId:'workflow-1',tokens:[],error:'invalid_command_cwd: package.json missing',execution:{active:false},current:{nodeId:'verify',status:'failed'}});
  assert.match(elements.runSummary.innerHTML,/\/bound\/repo/);
  assert.match(elements.runSummary.innerHTML,/invalid_command_cwd/);
  assert.match(elements.runSummary.innerHTML,/workflow-1/);
  assert.equal(elements.runBtn.disabled,true);
});


function modelRenderer(state) {
  const start=script.indexOf('  function modelProviders()');
  const end=script.indexOf('  function renderDetail()', start);
  const escaped=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  return new Function('state','modelDrafts','esc','busy',script.slice(start,end)+'; return {renderModelPicker,modelDraft};')(state,new Map(),escaped,false);
}

test('multi-model picker preserves explicit order and renders true multi-selection',()=>{
  const state={models:{providers:[{id:'p',name:'P',models:[{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}]}]},run:null};
  const node={id:'review',type:'agent',config:{models:[{provider:'p',model:'b'},{provider:'p',model:'a'}]}};
  const api=modelRenderer(state),html=api.renderModelPicker(node);
  assert.ok(html.indexOf('p / b')<html.indexOf('p / a'));
  assert.equal((html.match(/type="checkbox"/g)||[]).length,3);
  assert.equal((html.match(/ checked/g)||[]).length,2);
  assert.match(html,/data-model-action="up"/);assert.match(html,/data-model-action="down"/);
  assert.match(html,/保存模型顺序/);assert.doesNotMatch(html,/清除 fallback 列表/);
});

test('polling does not overwrite unsaved model order or escape unknown configured models',()=>{
  const state={models:{providers:[]},run:null};
  const node={id:'a',type:'agent',config:{models:[{provider:'p',model:'<old>'}]}};
  const api=modelRenderer(state),draft=api.modelDraft(node);
  draft.models.push({provider:'q',model:'new'});draft.dirty=true;
  node.config.models=[];
  const html=api.renderModelPicker(node);
  assert.match(html,/未保存/);assert.match(html,/&lt;old&gt;/);assert.ok(html.includes('q / new'));
  assert.doesNotMatch(html,/<old>/);
  assert.match(html,/模型目录暂不可用/);
});

test('active job locks model edits without dropping configured fallback list',()=>{
  const state={models:{providers:[{id:'p',models:[{id:'a'}]}]},run:{execution:{active:true}}};
  const html=modelRenderer(state).renderModelPicker({id:'x',config:{models:[{provider:'p',model:'a'}]}});
  assert.match(html,/data-model-clear disabled/);assert.match(html,/data-model-check[^>]* disabled/);
  assert.ok(html.includes('p / a'));
});

test('saving node models sends the complete ordered array, not one provider/model',async()=>{
  const start=script.indexOf('  async function saveNodeModels(models)');
  const end=script.indexOf('  async function decide(',start);
  const received=[];
  const fn=new Function('state','selected','API','SESSION','postJson','applyState','modelDrafts','render','toast','refreshModelPicker','busy',script.slice(start,end)+'; return saveNodeModels;')(
    {run:null},'review','/api','session',async(url,body)=>{received.push({url,body});return {};},()=>{},new Map(),()=>{},()=>{},()=>{},false);
  const models=[{provider:'p',model:'b'},{provider:'q',model:'a'}];
  await fn(models);
  assert.deepEqual(received,[{url:'/api/node-model',body:{session:'session',nodeId:'review',models}}]);
});
