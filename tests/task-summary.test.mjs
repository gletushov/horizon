import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../store.mjs';
import {WorkspaceStore} from '../workspace-store.mjs';

const source = '# Tasks\r\n\r\n| Task / session | Summary / purpose | Latest updates / next action | Letushv comments and decisions |\r\n|---|---|---|---|\r\n| T01 · [codex://task-1](codex://task-1) | Purpose text | Update text | &#32;мои&#32;слова&#32; |\r\n| T02 · Second | ** | Pending | ** |\r\n\r\nTail stays.\r\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-task-summary-'));
  fs.mkdirSync(path.join(root, 'reviews'));
  fs.writeFileSync(path.join(root, 'reviews/tasks.md'), source);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, store: new Store(root)};
}

function rowLine(content, id) {
  return content.split('\n').find(line => line.includes(`| ${id} ·`));
}

function cells(line) {
  return line.replace(/\r$/, '').split('|');
}

test('reads a task-summary table with an explicit four-column contract', t => {
  const {store} = fixture(t);
  const doc = store.read('reviews/tasks.md');

  assert.deepEqual(doc.reviewSchema, {
    version: 2,
    kind: 'task-summary',
    userColumn: 'comment',
    userColumnIndex: 3,
    idPrefix: 'T',
    columns: [
      {key: 'task', label: 'Task / session', index: 0, owner: 'agent'},
      {key: 'summary', label: 'Summary / purpose', index: 1, owner: 'agent'},
      {key: 'updates', label: 'Latest updates / next action', index: 2, owner: 'agent'},
      {key: 'comment', label: 'Letushv comments and decisions', index: 3, owner: 'user'}
    ]
  });
  assert.deepEqual({
    id: doc.rows[0].id,
    task: doc.rows[0].task,
    taskTitle: doc.rows[0].taskTitle,
    theme: doc.rows[0].theme,
    summary: doc.rows[0].summary,
    updates: doc.rows[0].updates,
    agent: doc.rows[0].agent,
    comment: doc.rows[0].comment,
    userComment: doc.rows[0].userComment,
    index: doc.rows[0].index,
    schema: doc.rows[0].schema,
    agentContent: doc.rows[0].agentContent,
    beforeAgentContent: doc.rows[0].beforeAgentContent
  }, {
    id: 'T01',
    task: 'T01 · [codex://task-1](codex://task-1)',
    taskTitle: '[codex://task-1](codex://task-1)',
    theme: 'T01 · [codex://task-1](codex://task-1)',
    summary: 'Purpose text',
    updates: 'Update text',
    agent: 'Update text',
    comment: ' мои слова ',
    userComment: ' мои слова ',
    index: 4,
    schema: 'task-summary',
    agentContent: {
      task: 'T01 · [codex://task-1](codex://task-1)',
      summary: 'Purpose text',
      updates: 'Update text'
    },
    beforeAgentContent: {
      task: 'T01 · [codex://task-1](codex://task-1)',
      summary: 'Purpose text',
      updates: 'Update text'
    }
  });
  assert.equal(doc.rows[1].summary, '');
  assert.equal(doc.rows[1].comment, '');
});

test('agent patch updates only supplied task-summary fields, keeps T IDs, and preserves user bytes', t => {
  const {store} = fixture(t);
  const before = store.read('reviews/tasks.md');
  const originalUserCell = cells(rowLine(before.content, 'T01'))[4];

  assert.throws(
    () => store.agentReview('reviews/tasks.md', before.revision, [
      {id: 'T01', updates: 'first'},
      {id: 'T01', updates: 'second'}
    ]),
    error => error.status === 400
  );
  assert.equal(store.read('reviews/tasks.md').content, before.content);

  const saved = store.agentReview('reviews/tasks.md', before.revision, [
    {id: 'T01', task: 'T99 · Renamed task', summary: 'New purpose', updates: 'Changed | update\nwith line'},
    {task: 'Third task', summary: 'Third purpose', updates: 'Third update'}
  ]);

  const first = saved.rows.find(row => row.id === 'T01');
  assert.equal(first.task, 'T01 · Renamed task');
  assert.equal(first.summary, 'New purpose');
  assert.equal(first.updates, 'Changed | update\nwith line');
  assert.equal(first.comment, ' мои слова ');
  assert.equal(cells(rowLine(saved.content, 'T01'))[4], originalUserCell);
  assert.equal(saved.rows.at(-1).id, 'T03');
  assert.equal(saved.rows.at(-1).task, 'T03 · Third task');
  assert.equal(saved.rows.at(-1).summary, 'Third purpose');
  assert.equal(saved.rows.at(-1).updates, 'Third update');
  assert.equal(saved.rows.at(-1).comment, '');
  assert.match(saved.content, /Tail stays\.\r\n$/);
});

test('history detects summary changes and agent-only restore preserves the current comment bytes', t => {
  const {store} = fixture(t);
  let doc = store.read('reviews/tasks.md');
  const initial = store.history(doc.path).find(version => store.version(doc.path, version.id).content === source);

  doc = store.agentReview(doc.path, doc.revision, [{id: 'T01', summary: 'Changed purpose'}]);
  assert.equal(doc.rows[0].updates, 'Update text');
  assert.equal(doc.rows[0].updated, true);
  assert.deepEqual(doc.rows[0].agentContent, {
    task: 'T01 · [codex://task-1](codex://task-1)',
    summary: 'Changed purpose',
    updates: 'Update text'
  });
  assert.deepEqual(doc.rows[0].beforeAgentContent, {
    task: 'T01 · [codex://task-1](codex://task-1)',
    summary: 'Purpose text',
    updates: 'Update text'
  });

  doc = store.comment(doc.path, doc.revision, [{id: 'T01', comment: '  новое | решение\nдальше  '}]);
  const commentBytes = cells(rowLine(doc.content, 'T01'))[4];
  const currentRevision = doc.revision;
  const restored = store.restoreVersion(doc.path, currentRevision, initial.id, 'agent', 'T01');

  assert.equal(restored.rows[0].summary, 'Purpose text');
  assert.equal(restored.rows[0].updates, 'Update text');
  assert.equal(cells(rowLine(restored.content, 'T01'))[4], commentBytes);
  assert.throws(
    () => store.restoreVersion(doc.path, currentRevision, initial.id, 'agent', 'T01'),
    error => error.status === 409
  );
});

test('WorkspaceStore exposes the same v2 contract for a connected project', t => {
  const horizonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-workspace-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-project-'));
  fs.mkdirSync(path.join(projectRoot, 'reviews'));
  fs.writeFileSync(path.join(projectRoot, 'reviews/tasks.md'), source);
  fs.writeFileSync(path.join(horizonRoot, 'horizon.config.json'), JSON.stringify({projects: [{id: 'demo', name: 'Demo', path: projectRoot}]}));
  t.after(() => {
    fs.rmSync(horizonRoot, {recursive: true, force: true});
    fs.rmSync(projectRoot, {recursive: true, force: true});
  });

  const workspace = new WorkspaceStore(horizonRoot);
  const doc = workspace.read('projects/demo/reviews/tasks.md');
  assert.equal(doc.reviewSchema.kind, 'task-summary');
  const saved = workspace.comment(doc.path, doc.revision, [{id: 'T02', comment: 'Решение пользователя'}]);
  assert.equal(saved.rows.find(row => row.id === 'T02').comment, 'Решение пользователя');
  assert.equal(new WorkspaceStore(horizonRoot).read(doc.path).reviewSchema.userColumnIndex, 3);
});

test('review-agent CLI reads and writes v2 fields without accepting a stale revision', t => {
  const {root} = fixture(t);
  const read = spawnSync(process.execPath, ['scripts/review-agent.mjs', 'read', root, 'reviews/tasks.md'], {encoding: 'utf8'});
  assert.equal(read.status, 0, read.stderr);
  const doc = JSON.parse(read.stdout);
  const changesPath = path.join(root, 'changes.json');
  fs.writeFileSync(changesPath, JSON.stringify({revision: doc.revision, changes: [{id: 'T01', updates: 'CLI update'}]}));
  const update = spawnSync(process.execPath, ['scripts/review-agent.mjs', 'update', root, 'reviews/tasks.md', changesPath], {encoding: 'utf8'});
  assert.equal(update.status, 0, update.stderr);
  const saved = JSON.parse(update.stdout);
  assert.equal(saved.reviewSchema.kind, 'task-summary');
  assert.equal(saved.rows.find(row => row.id === 'T01').updates, 'CLI update');

  fs.writeFileSync(changesPath, JSON.stringify({revision: doc.revision, changes: [{id: 'T01', updates: 'stale'}]}));
  const stale = spawnSync(process.execPath, ['scripts/review-agent.mjs', 'update', root, 'reviews/tasks.md', changesPath], {encoding: 'utf8'});
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Ревью изменилось/);
});

test('pickup belongs to the exact user comment, not a later edit', t => {
 const {store}=fixture(t);let doc=store.read('reviews/tasks.md');
 doc=store.agentReview(doc.path,doc.revision,[{id:'T01',updates:'**In progress.** Working on this comment.'}]);
 assert.equal(doc.rows[0].commentInProgress,true);
 const firstComment=doc.rows[0].comment;
 doc=store.save(doc.path,doc.revision,doc.content.replace('&#32;мои&#32;слова&#32;','новое замечание'));
 assert.notEqual(doc.rows[0].comment,firstComment);assert.equal(doc.rows[0].commentInProgress,false);
 doc=store.agentReview(doc.path,doc.revision,[{id:'T01',updates:'**Needs review.** Done.',acknowledgeComment:true}]);
 assert.equal(doc.rows[0].commentInProgress,false);assert.equal(doc.rows[0].commentAcknowledged,true);
});
