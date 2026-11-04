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

function loadPluginFace() {
  const entry = loadBundle();
  return entry.factory(name => {
    if (name === 'react') return { createElement: () => ({}) };
    throw new Error(`unexpected module ${name}`);
  });
}

test('registers the package identity', () => {
  const entry = loadBundle();
  assert.equal(entry.id, 'dsh-agent-team-workflow');
  assert.equal(typeof entry.factory, 'function');
});

test('client factory returns the Cordis plugin face', () => {
  const module = loadPluginFace();
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual([...module.inject], ['slots', 'sidebarRightTabs']);
});

test('the sidebar panel implementation is gone', () => {
  assert.ok(!SOURCE.includes('sidebar.right.pane.tab'));
  assert.ok(!SOURCE.includes('sidebarRightTabs.register'));
  assert.ok(!SOURCE.includes('WorkflowPanel'));
  assert.ok(!SOURCE.includes('atw-panel'));
  assert.ok(!SOURCE.includes('team-workflow-board'));
  assert.ok(!SOURCE.includes('openBoardOverlay'));
});

test('one header action opens the native Browser board', () => {
  assert.ok(SOURCE.includes('conversation.session.header.actions'));
  assert.ok(SOURCE.includes('id: "team-workflow-open"'));
  assert.ok(SOURCE.includes('/board-url?session='));
  assert.ok(SOURCE.includes('openTab("browser"'));
  assert.ok(SOURCE.includes('window.location.assign'));
  assert.ok(SOURCE.includes('const TITLE = "工作流"'));
  assert.ok(SOURCE.includes('sessionId'));
});

test('apply registers exactly the single header entry', () => {
  const module = loadPluginFace();
  const captured = { slots: [], tabs: [], opened: null };
  const ctx = {
    effect(fn) {
      fn();
    },
    sidebarRightTabs: {
      get(kind) {
        captured.tabs.push(kind);
        return kind === 'browser' ? { kind } : undefined;
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
  assert.equal(captured.slots.length, 1);
  assert.equal(captured.slots[0].definition.name, 'conversation.session.header.actions');
  assert.equal(captured.slots[0].definition.id, 'team-workflow-open');
  assert.equal(typeof captured.slots[0].component, 'function');
  assert.deepEqual(captured.tabs, []);
});
