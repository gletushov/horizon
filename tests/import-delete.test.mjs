import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../store.mjs';
import {WorkspaceStore} from '../workspace-store.mjs';
import {createApp} from '../server.mjs';

function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'reviews'), {recursive: true});
  fs.mkdirSync(path.join(root, 'planner'), {recursive: true});
  return root;
}

function cleanup(t, ...roots) {
  t.after(() => roots.forEach(root => fs.rmSync(root, {recursive: true, force: true})));
}

test('imports multiple Markdown files after an all-or-nothing preflight', t => {
  const root = tempRoot('horizon-import-'); cleanup(t, root);
  const store = new Store(root);
  const original = '# source remains outside Horizon';
  const files = [
    {name: 'one.md', content: '# One\n'},
    {name: 'two.md', content: '# Two\n'}
  ];

  const result = store.importDocuments('reviews', files);
  assert.deepEqual(result.map(doc => doc.path), ['reviews/one.md', 'reviews/two.md']);
  assert.equal(store.read('reviews/one.md').content, files[0].content);
  assert.equal(store.read('reviews/two.md').content, files[1].content);
  assert.equal(original, '# source remains outside Horizon');

  assert.throws(
    () => store.importDocuments('reviews', [{name: 'three.md', content: 'new'}, {name: 'one.md', content: 'overwrite'}]),
    error => error.status === 409
  );
  assert.equal(fs.existsSync(path.join(root, 'reviews/three.md')), false);
  assert.equal(fs.readFileSync(path.join(root, 'reviews/one.md'), 'utf8'), files[0].content);

  assert.throws(
    () => store.importDocuments('reviews', [{name: 'four.md', content: 'new'}, {name: 'four.md', content: 'duplicate'}]),
    error => error.status === 400
  );
  assert.equal(fs.existsSync(path.join(root, 'reviews/four.md')), false);
  assert.throws(() => store.importDocuments('reviews', [{name: '../escape.md', content: 'bad'}]), error => error.status === 400);
  assert.equal(fs.existsSync(path.join(root, 'escape.md')), false);
  assert.throws(() => store.importDocuments('reviews', [{name: 'large.md', content: 'x'.repeat(2_000_001)}]), error => error.status === 413);
  assert.equal(fs.existsSync(path.join(root, 'reviews/large.md')), false);
});

test('imports through WorkspaceStore into a connected project root and keeps project paths decorated', t => {
  const root = tempRoot('horizon-workspace-import-');
  const project = tempRoot('horizon-project-import-');
  cleanup(t, root, project);
  fs.writeFileSync(path.join(root, 'horizon.config.json'), JSON.stringify({projects: [{id: 'demo', name: 'Demo', path: project}]}));
  const workspace = new WorkspaceStore(root);

  const [doc] = workspace.importDocuments('projects/demo', [{name: 'readme.md', content: '# Project\n'}]);
  assert.equal(doc.path, 'projects/demo/readme.md');
  assert.equal(doc.sourcePath, path.join(project, 'readme.md'));
  assert.equal(fs.readFileSync(path.join(project, 'readme.md'), 'utf8'), '# Project\n');
});

test('deletes one horizon task with its nested block and leaves an undo history version', t => {
  const root = tempRoot('horizon-delete-task-'); cleanup(t, root);
  const content = '# Day\n- [ ] Parent\n  - [ ] Child\n  - detail\n\n- [x] Keep\n';
  fs.writeFileSync(path.join(root, 'planner/day.md'), content);
  const store = new Store(root);
  const before = store.read('planner/day.md');
  const deleted = store.deleteTask(before.path, before.revision, 1);

  assert.equal(deleted.ok, true);
  assert.match(deleted.content, /Keep/);
  assert.doesNotMatch(deleted.content, /Parent|Child|detail/);
  assert.equal(deleted.deleted.index, 1);
  assert.match(deleted.deleted.content, /Parent\n  - \[ \] Child/);
  assert.ok(deleted.undoVersion);
  const undo = store.version(before.path, deleted.undoVersion);
  assert.equal(undo.content, content);
  assert.throws(() => store.deleteTask(before.path, before.revision, 1), error => error.status === 409);
  const restored = store.restoreVersion(before.path, deleted.revision, deleted.undoVersion, 'document');
  assert.equal(restored.content, content);
  assert.throws(() => store.deleteTask(before.path, deleted.revision, 1), error => error.status === 409);
});

test('delete-task rejects non-top-level rows and stale drag revisions without changing either horizon', t => {
  const root = tempRoot('horizon-delete-conflict-'); cleanup(t, root);
  const day = '# Day\n- [ ] Parent\n  - [ ] Child\n';
  fs.writeFileSync(path.join(root, 'planner/day.md'), day);
  const store = new Store(root);
  const before = store.read('planner/day.md');
  assert.throws(() => store.deleteTask(before.path, before.revision, 2), error => error.status === 400);
  assert.equal(fs.readFileSync(path.join(root, 'planner/day.md'), 'utf8'), day);
  fs.writeFileSync(path.join(root, 'planner/day.md'), day + '\n- [ ] Later\n');
  assert.throws(() => store.deleteTask(before.path, before.revision, 1), error => error.status === 409);
});

test('moveTask rejects a stale drag target before changing the source', t => {
  const root = tempRoot('horizon-move-conflict-'); cleanup(t, root);
  const source = '# Day\n- [ ] Parent\n  - [ ] Child\n';
  const target = '# Week\n- [ ] Existing\n';
  fs.writeFileSync(path.join(root, 'planner/day.md'), source);
  fs.writeFileSync(path.join(root, 'planner/week.md'), target);
  const store = new Store(root);
  const from = store.read('planner/day.md');
  const to = store.read('planner/week.md');
  fs.writeFileSync(path.join(root, 'planner/week.md'), target + '- [ ] External\n');
  assert.throws(() => store.moveTask(from.path, from.revision, 1, to.path, to.revision, 1), error => error.status === 409);
  assert.equal(fs.readFileSync(path.join(root, 'planner/day.md'), 'utf8'), source);
});

test('HTTP import and delete-task routes return fresh documents', async t => {
  const root = tempRoot('horizon-http-'); cleanup(t, root);
  fs.writeFileSync(path.join(root, 'planner/day.md'), '# Day\n- [ ] Parent\n  - [ ] Child\n');
  const server = createApp(root);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  t.after(() => server.close());
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const importedResponse = await fetch(`${origin}/api/import`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({destination: 'reviews', files: [{name: 'http.md', content: '# HTTP\n'}]})
  });
  assert.equal(importedResponse.status, 200);
  const imported = await importedResponse.json();
  assert.equal(imported.documents[0].path, 'reviews/http.md');

  const beforeResponse = await fetch(`${origin}/api/document?path=${encodeURIComponent('planner/day.md')}`);
  const before = await beforeResponse.json();
  const deletedResponse = await fetch(`${origin}/api/delete-task`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({path: 'planner/day.md', revision: before.revision, index: 1})
  });
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json();
  assert.doesNotMatch(deleted.content, /Parent|Child/);
  assert.ok(deleted.undoVersion);
});
