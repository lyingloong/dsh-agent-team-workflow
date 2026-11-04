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

function loadPluginFace() {
  const entry = loadBundle();
  const module = entry.factory(name => {
    if (name === 'react') return fakeReact();
    throw new Error(`unexpected module ${name}`);
  });
  return module;
}

test('registers a v2 client entry with the package identity', () => {
  const entry = loadBundle();
  assert.equal(entry.id, 'dsh-agent-team-workflow');
  assert.equal(typeof entry.factory, 'function');
});

test('client factory returns the Cordis plugin face', () => {
  const module = loadPluginFace();
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
  assert.ok(SOURCE.includes('/state?session='));
  assert.ok(!SOURCE.includes('/board?session='));
  assert.ok(SOURCE.includes('sessionId'));
});

test('apply registers the tab, the pane body and the header entry', () => {
  const module = loadPluginFace();
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

test('graph uses Cytoscape with dagre layout and taxi edge routing', () => {
  assert.ok(SOURCE.includes('cytoscape'));
  assert.ok(SOURCE.includes('cytoscape-dagre'));
  assert.ok(SOURCE.includes('name: "dagre"'));
  assert.ok(SOURCE.includes('"curve-style": "taxi"'));
  assert.ok(SOURCE.includes('atw-graph-canvas'));
  assert.ok(SOURCE.includes('atw-graph-tool'));
  assert.ok(SOURCE.includes('function graphElements'));
});

test('panel exposes v2 run state, node details, decisions and permissions', () => {
  assert.ok(SOURCE.includes('function WorkflowGraph'));
  assert.ok(SOURCE.includes('atw-graph-canvas'));
  assert.ok(SOURCE.includes('atw-graph-tool'));
  assert.ok(SOURCE.includes('"curve-style": "taxi"'));
  assert.ok(SOURCE.includes('name: "dagre"'));
  assert.ok(SOURCE.includes('run?.waiting'));
  assert.ok(SOURCE.includes('run?.tokens'));
  assert.ok(!SOURCE.includes('atw-progress'));
  assert.ok(SOURCE.includes('atw-waiting'));
  assert.ok(SOURCE.includes('atw-sheet'));
  assert.ok(SOURCE.includes('atw-permissions'));
  assert.ok(SOURCE.includes('atw-token'));
  assert.ok(SOURCE.includes('command') && SOURCE.includes('http'));
  assert.ok(SOURCE.includes('/models?session='));
  assert.ok(SOURCE.includes('/node-model'));
  assert.ok(SOURCE.includes('atw-model-select'));
  assert.ok(SOURCE.includes('atw-model-row'));
  assert.ok(SOURCE.includes('changeModels'));
  assert.ok(SOURCE.includes('ResizeObserver'));
  assert.ok(SOURCE.includes('graphElements'));
  assert.ok(SOURCE.includes('graphLabel'));
  assert.ok(SOURCE.includes('TYPE_STYLE'));
});
