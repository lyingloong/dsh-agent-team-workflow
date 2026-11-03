import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadBundle() {
  let entry;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          entry = value;
        },
      },
    },
    console,
  };
  vm.runInNewContext(SOURCE, sandbox);
  assert.ok(entry, 'bundle must call window.__ModuleLoader__.load');
  return entry;
}

function fakeReact() {
  return {
    createElement() {
      return {};
    },
    useCallback(fn) {
      return fn;
    },
    useEffect() {},
    useRef() {
      return { current: true };
    },
    useState() {
      return [undefined, () => {}];
    },
  };
}

test('registers a client entry with the package identity', () => {
  const entry = loadBundle();
  assert.equal(entry.id, 'dsh-agent-team-workflow');
  assert.equal(typeof entry.factory, 'function');
});

test('client factory returns the Cordis plugin face', () => {
  const entry = loadBundle();
  const module = entry.factory(name => {
    if (name === 'react') return fakeReact();
    throw new Error(`unexpected module ${name}`);
  });
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual([...module.inject], ['slots', 'sidebarRightTabs']);
});

test('client registers the right-sidebar tab and opens it from the conversation header', () => {
  assert.ok(SOURCE.includes('sidebarRightTabs.register'));
  assert.ok(SOURCE.includes('kind: "team-workflow"'));
  assert.ok(SOURCE.includes('sidebar.right.pane.tab'));
  assert.ok(SOURCE.includes('key: "dsh-agent-team-workflow"'));
  assert.ok(SOURCE.includes('conversation.session.header.actions'));
  assert.ok(SOURCE.includes('openTab("team-workflow")'));
  assert.ok(SOURCE.includes('/plugins/dsh-agent-team-workflow/api'));
  assert.ok(SOURCE.includes('/board?session='));
  assert.ok(SOURCE.includes('sessionId'));
});

test('apply registers the tab, the pane body and the header entry', () => {
  const entry = loadBundle();
  const module = entry.factory(name => {
    if (name === 'react') return fakeReact();
    throw new Error(`unexpected module ${name}`);
  });
  const captured = { tab: null, slots: [], opened: null };
  const ctx = {
    effect(fn) {
      fn();
    },
    sidebarRightTabs: {
      register(definition) {
        captured.tab = definition;
        return () => {};
      },
    },
    slots: {
      inject(_key, callback) {
        callback();
      },
      register(definition, component) {
        captured.slots.push({ definition, component });
      },
    },
    get(name) {
      if (name === 'sidebarRight') return { openTab: kind => { captured.opened = kind; } };
      return undefined;
    },
  };
  module.apply(ctx);
  assert.equal(captured.tab.id, 'dsh-agent-team-workflow');
  assert.equal(captured.tab.kind, 'team-workflow');
  assert.equal(captured.tab.title(), '工作流');
  const body = captured.slots.find(slot => slot.definition.name === 'sidebar.right.pane.tab');
  assert.equal(body.definition.key, 'dsh-agent-team-workflow');
  const header = captured.slots.find(slot => slot.definition.name === 'conversation.session.header.actions');
  assert.equal(header.definition.id, 'team-workflow-open');
  header.definition.inject().open();
  assert.equal(captured.opened, 'team-workflow');
});

test('client renders the workflow DAG and its transitions', () => {
  assert.ok(SOURCE.includes('function buildGraph'));
  assert.ok(SOURCE.includes('function WorkflowGraph'));
  assert.ok(SOURCE.includes('atw-graph-svg'));
  assert.ok(SOURCE.includes('edge.label'));
  assert.ok(SOURCE.includes('needs_revision'));
});

test('buildGraph layers a branch, labels outcomes and routes a loop', () => {
  const start = SOURCE.indexOf('function buildGraph');
  const end = SOURCE.indexOf('function WorkflowGraph');
  assert.ok(start > 0 && end > start);
  const buildGraph = new Function(`${SOURCE.slice(start, end)}; return buildGraph;`)();
  const graph = buildGraph({
    entry: 'a',
    stages: [
      { id: 'a', title: 'A', role: 'worker', on: { complete: 'b' } },
      { id: 'b', title: 'B', role: 'reviewer', on: { pass: 'c', needs_revision: 'b' } },
      { id: 'c', title: 'C', role: 'releaser', on: {} },
    ],
    gates: [{ after: 'b', outcome: 'pass' }],
  });
  const a = graph.nodes.find(node => node.id === 'a');
  const b = graph.nodes.find(node => node.id === 'b');
  const c = graph.nodes.find(node => node.id === 'c');
  assert.ok(a.y < b.y && b.y < c.y);
  assert.ok(graph.edges.some(edge => edge.label === 'pass · gate'));
  assert.ok(graph.edges.some(edge => edge.label === 'needs_revision'));
});

test('panel exposes overview, filters, structured cards and feedback', () => {
  assert.ok(!SOURCE.includes('atw-progress'));
  assert.ok(SOURCE.includes('atw-stats'));
  assert.ok(SOURCE.includes('durationSince'));
  assert.ok(SOURCE.includes('maxWidth: "100%"'));
  assert.ok(SOURCE.includes('atw-filter'));
  assert.ok(SOURCE.includes('atw-banner'));
  assert.ok(SOURCE.includes('atw-toast'));
  assert.ok(SOURCE.includes('timeAgo'));
  assert.ok(SOURCE.includes('detailRows'));
});

test('graph affordances do not rely on instructional microcopy', () => {
  assert.ok(!SOURCE.includes('点击节点筛选'));
  assert.ok(!SOURCE.includes('atw-graph-hint'));
  assert.ok(!SOURCE.includes('atw-graph-legend'));
  assert.ok(SOURCE.includes('atw-executor'));
  assert.ok(SOURCE.includes('maxWidth: "100%"'));
});
