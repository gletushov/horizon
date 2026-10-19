import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {startDesktopServer, navigationAction} from '../desktop/runtime.mjs';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-desktop-'));
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  return path.join(parent, 'workspace');
}

test('a new desktop workspace opens Agents, notes and bundled assets without Node setup', async t => {
  const root = workspace(t);
  const app = await startDesktopServer(root);
  t.after(() => app.close());
  for (const route of ['/', '/api/review', '/api/notes', '/vendor/marked.js', '/fonts/Commissioner.woff2']) {
    const response = await fetch(app.url + route);
    assert.equal(response.status, 200, route + ' must work on a fresh install');
  }
  assert.deepEqual((await (await fetch(app.url + '/api/review')).json()).rows, []);
  assert.deepEqual((await (await fetch(app.url + '/api/documents')).json()).projects.map(p => p.id), [null]);
});

test('notes and the browser origin survive quit and relaunch without overwriting existing files', async t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'docs'), {recursive: true});
  fs.writeFileSync(path.join(root, 'docs/keep.md'), '# Existing owner document\n');
  let app = await startDesktopServer(root);
  t.after(() => app?.close());
  const firstURL = app.url;
  const response = await fetch(app.url + '/api/notes', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'add', revision: null, id: randomUUID(), text: 'Survives restart'})});
  assert.equal(response.status, 200);
  await app.close();
  app = await startDesktopServer(root);
  assert.equal(app.url, firstURL, 'a different origin loses local drafts and editor preferences');
  assert.match(JSON.stringify(await (await fetch(app.url + '/api/notes')).json()), /Survives restart/);
  assert.equal(fs.readFileSync(path.join(root, 'docs/keep.md'), 'utf8'), '# Existing owner document\n');
});

test('an occupied saved port fails instead of opening another local service or losing drafts', async t => {
  const root = workspace(t);
  const app = await startDesktopServer(root);
  const port = Number(new URL(app.url).port);
  await app.close();
  const occupant = http.createServer((req, res) => res.end('another application'));
  await new Promise(resolve => occupant.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupant.close(resolve)));
  let unexpected;
  try {
    await assert.rejects(async () => { unexpected = await startDesktopServer(root); }, {code: 'EADDRINUSE'});
  } finally { await unexpected?.close(); }
});

test('desktop navigation keeps its own pages local and allows only web links in the browser', () => {
  const origin = 'http://127.0.0.1:4318';
  assert.equal(navigationAction(origin + '/#docs', origin), 'internal');
  assert.equal(navigationAction('https://github.com/gletushov/horizon', origin), 'external');
  assert.equal(navigationAction('codex://threads/11111111-1111-4111-8111-111111111111', origin), 'external');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'http://127.0.0.1:9999', 'codex://thread/test', 'invalid']) {
    assert.equal(navigationAction(url, origin), 'blocked', url);
  }
});

test('an agent brief from a separate workspace points to usable installed CLI tools', async t => {
  const root = workspace(t);
  const app = await startDesktopServer(root);
  t.after(() => app.close());
  const post = async (route, body) => {
    const response = await fetch(app.url + route, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal(response.status, 200);
    return response.json();
  };
  const review = await (await fetch(app.url + '/api/review')).json();
  const created = await post('/api/review', {action: 'create', title: 'Portable task', projectId: null, comment: 'Please review', revision: review.revision});
  const brief = await post('/api/review/brief', {id: created.createdId, revision: created.revision, copy: true});
  const helper = brief.prompt.match(/через (.*?) с новой revision/s)?.[1];
  assert.ok(helper && fs.existsSync(helper), 'the agent must be able to run the advertised CLI outside the data folder');
  const skill = brief.prompt.match(/ and (.*?)\. Read project/s)?.[1];
  assert.ok(skill && fs.existsSync(skill), 'the advertised instructions must exist');
  const read = spawnSync(process.execPath, [helper, 'read', root, 'reviews/agent-overview.md'], {encoding: 'utf8'});
  assert.equal(read.status, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).rows[0].taskTitle, 'Portable task');
});
