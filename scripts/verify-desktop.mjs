// Exercise the actual Electron main process, renderer, filesystem and relaunch.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-app-check-'));
const userData = path.join(temporary, 'profile');
const root = path.join(userData, 'workspace');
const output = path.resolve(process.env.HORIZON_CHECK_OUTPUT || 'output/desktop');
fs.mkdirSync(output, {recursive: true});
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const env = {...process.env, HORIZON_USER_DATA: userData, HORIZON_ROOT: root,
  HORIZON_CODEX_BIN: path.join(temporary, 'no-codex'), HORIZON_CODEX_AUTOSTART: '0'};
delete env.ELECTRON_RUN_AS_NODE;
let running;
const errors = [];
async function launch() {
  running = await electron.launch({executablePath, args: executablePath ? [] : ['.'], env, timeout: 90000});
  const page = await running.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-nav="inbox"]').waitFor();
  return page;
}

try {
  let page = await launch();
  const origin = new URL(page.url()).origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  const security = await running.evaluate(({BrowserWindow}) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation};
  });
  assert.deepEqual(security, {sandbox: true, nodeIntegration: false, contextIsolation: true});
  await page.locator('.review-workspace').waitFor();
  const brief = await page.evaluate(async () => {
    const post = async (route, body) => (await fetch(route, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})).json();
    const current = await (await fetch('/api/review')).json();
    const created = await post('/api/review', {action: 'create', title: 'Проверка macOS-приложения', projectId: null, comment: 'Проверить рабочую папку и сохранение', revision: current.revision});
    return post('/api/review/brief', {id: created.createdId, revision: created.revision, copy: true});
  });
  const helper = brief.prompt.match(/через (.*?) с новой revision/s)?.[1];
  const skill = brief.prompt.match(/ and (.*?)\. Read project/s)?.[1];
  assert.ok(helper && fs.existsSync(helper));
  assert.ok(skill && fs.existsSync(skill));
  const cli = spawnSync(process.execPath, [helper, 'read', root, 'reviews/agent-overview.md'], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  await page.reload();
  await page.getByRole('button', {name: 'Скопировать задачу', exact: true}).click();
  await page.locator('[data-save-state]').filter({hasText: 'Скопировано'}).waitFor();
  assert.match(await running.evaluate(({clipboard}) => clipboard.readText()), /Проверить рабочую папку/);
  await page.screenshot({path: path.join(output, 'agents.png')});
  await page.locator('[data-nav="inbox"]').click();
  await page.locator('#note-capture').fill('Заметка из настоящего macOS-приложения');
  await page.getByRole('button', {name: 'Добавить', exact: true}).click();
  await page.locator('.continuous-note-entry').waitFor();
  assert.match(fs.readFileSync(path.join(root, 'notes/continuous-note.md'), 'utf8'), /настоящего macOS/);
  await page.locator('#note-capture').fill('Несохранённый черновик после перезапуска');
  await page.screenshot({path: path.join(output, 'notes.png')});
  // Closing a macOS window must keep the app/server alive; Dock activation restores it.
  await running.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await running.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  await running.evaluate(({app}) => app.emit('activate'));
  assert.equal(await running.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  await running.close(); running = null;
  await assert.rejects(fetch(origin + '/api/health'), 'quit must stop the owned HTTP server');

  page = await launch();
  assert.equal(new URL(page.url()).origin, origin);
  await page.locator('[data-nav="inbox"]').click();
  await page.locator('.continuous-note-entry').waitFor();
  assert.equal(await page.locator('#note-capture').inputValue(), 'Несохранённый черновик после перезапуска');
  assert.match(await page.locator('.continuous-note-entry').innerText(), /настоящего macOS/);
  await page.screenshot({path: path.join(output, 'relaunched.png')});
  // External file navigation must be stopped by the real Electron window.
  await page.evaluate(() => { location.href = 'file:///etc/passwd'; });
  await page.waitForURL(origin + '/#inbox');
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed: true, executable: executablePath || 'development', screenshots: output,
    checks: ['fresh workspace', 'sandbox', 'note saved to disk', 'draft after relaunch', 'stable origin', 'hide and Dock restore', 'server stopped on quit', 'file navigation blocked']}));
} finally {
  if (running) await running.close();
  fs.rmSync(temporary, {recursive: true, force: true});
}
