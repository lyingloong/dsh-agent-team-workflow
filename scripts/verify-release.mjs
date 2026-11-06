#!/usr/bin/env node
/** Read-only release preflight; runs from a checkout or an unpacked release. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeDefinition } from '../src/v2/definition.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-auto-workflow');
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(pkg.private, false);
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.repository.url, 'git+https://github.com/lyingloong/dsh-agent-team-workflow.git');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, 'release tag must match the manifest');

const files = new Set(['package.json']);
async function collect(relative) {
  const location = path.resolve(root, relative);
  assert.ok(location.startsWith(root + path.sep), 'package path must stay inside the root');
  const info = await fs.lstat(location);
  assert.equal(info.isSymbolicLink(), false, `no links in release content: ${relative}`);
  if (info.isDirectory()) {
    for (const entry of await fs.readdir(location)) await collect(path.join(relative, entry));
  } else {
    assert.ok(info.isFile(), `regular file required: ${relative}`);
    files.add(relative.replaceAll(path.sep, '/'));
  }
}
for (const entry of pkg.files) await collect(entry);
for (const name of ['CHANGELOG.md', 'LICENSE', 'lib/client.js', 'src/v2/board.html', 'src/v2/permissions.mjs', 'src/v2/command.mjs', 'docs/verification.md', `docs/releases/v${pkg.version}.md`, 'docs/examples/development/workflow.json', 'docs/examples/development/driver.mjs', 'docs/examples/development/store.mjs', 'docs/examples/development/worktrees.mjs']) {
  assert.ok(files.has(name), `required release file missing: ${name}`);
}
for (const target of Object.values(pkg.exports)) {
  assert.ok(files.has(target.replace(/^\.\//, '')), `export missing from the package: ${target}`);
}
const forbiddenFile = /(?:^|\/)(?:tmp|node_modules|\.local-deployments|\.git|audit-evidence)(?:\/|$)|\.(?:log|sqlite3|tgz)$/;
const privateContent = /[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[?&]token=[a-f0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|session-[0-9a-f]{8}-[0-9a-f-]{27,}/i;
let links = 0;
for (const relative of files) {
  assert.equal(forbiddenFile.test(relative), false, `private/development artifact in package: ${relative}`);
  if (!/\.(?:md|mjs|js|json|yml|yaml)$/.test(relative)) continue;
  const content = await fs.readFile(path.join(root, relative), 'utf8');
  assert.equal(privateContent.test(content), false, `machine-private path or credential-like data in ${relative}`);
  if (!relative.endsWith('.md')) continue;
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    target = decodeURIComponent(target.split('#')[0]);
    if (!target) continue;
    assert.equal(path.isAbsolute(target) || /^[A-Za-z]:/.test(target), false, `absolute local link in ${relative}`);
    const resolved = path.relative(root, path.resolve(root, path.dirname(relative), target)).replaceAll(path.sep, '/');
    assert.ok(files.has(resolved), `broken package-relative link in ${relative}: ${target}`);
    links++;
  }
}
const face = await import(pathToFileURL(path.resolve(root, pkg.exports['.'])).href);
assert.equal(face.name, pkg.name); assert.equal(typeof face.apply, 'function');
const client = await fs.readFile(path.join(root, pkg.exports['./client']), 'utf8');
assert.ok(client.includes('id: "dsh-auto-workflow"'));
const patch = await fs.readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /id: dsh-auto-workflow/);
const definition = normalizeDefinition(JSON.parse(await fs.readFile(path.join(root, 'docs/examples/development/workflow.json'), 'utf8')));
assert.equal(definition.concurrency, 6);
assert.equal(definition.nodes.find(node => node.id === 'engineer')?.concurrency, 3);
assert.equal(definition.nodes.find(node => node.id === 'reviewer')?.concurrency, 3);
assert.equal(definition.nodes.find(node => node.id === 'integrate')?.concurrency, 1);
assert.equal(definition.nodes.some(node => node.type === 'http'), false, 'the first-release example has no implicit remote GitHub access');
console.log(JSON.stringify({ package: `${pkg.name}@${pkg.version}`, files: files.size, localLinks: links, graph: { nodes: definition.nodes.length, edges: definition.edges.length, concurrency: definition.concurrency }, result: 'passed' }, null, 2));
