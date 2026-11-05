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
