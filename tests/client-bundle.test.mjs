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
  assert.ok(SOURCE.includes('/board?workspace='));
});
