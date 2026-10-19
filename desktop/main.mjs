import {app, BrowserWindow, Menu, dialog, shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startDesktopServer, navigationAction} from './runtime.mjs';

app.setName('Horizon');
if (process.env.HORIZON_USER_DATA) app.setPath('userData', path.resolve(process.env.HORIZON_USER_DATA));

let window, runtime, exiting = false;
const settingsPath = () => path.join(app.getPath('userData'), 'desktop.json');

async function saveBeforeQuit() {
  if (!window || window.isDestroyed()) return true;
  window.webContents.executeJavaScript('document.activeElement?.blur()').catch(() => {});
  const results = await window.webContents.executeJavaScript(
    'typeof documentSessions === "undefined" ? [] : Promise.all([...documentSessions.values()].map(session => session.flush()))'
  ).catch(() => [false]);
  if (results.every(Boolean)) return true;
  const answer = await dialog.showMessageBox(window, {
    type: 'warning', message: 'Не все изменения удалось сохранить в файлы',
    detail: 'Черновики остаются в Horizon на этом Mac.',
    buttons: ['Остаться', 'Выйти с черновиками'], defaultId: 0, cancelId: 0
  });
  return answer.response === 1;
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(window, {
    title: 'Рабочая папка Horizon', defaultPath: runtime.root,
    properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Открыть'
  });
  if (result.canceled || result.filePaths[0] === runtime.root || !await saveBeforeQuit()) return;
  fs.mkdirSync(app.getPath('userData'), {recursive: true});
  fs.writeFileSync(settingsPath(), JSON.stringify({workspace: result.filePaths[0]}) + '\n', {mode: 0o600});
  app.relaunch();
  app.quit();
}

function showWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  const partition = 'persist:workspace-' + createHash('sha256').update(runtime.root).digest('hex').slice(0, 16);
  window = new BrowserWindow({
    title: 'Horizon', width: 1280, height: 900, minWidth: 760, minHeight: 560,
    backgroundColor: '#f6f5f1', show: false,
    webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, partition}
  });
  const canWriteClipboard = (permission, url) => permission === 'clipboard-sanitized-write' && navigationAction(url, runtime.url) === 'internal';
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(canWriteClipboard(permission, contents.getURL())));
  window.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => canWriteClipboard(permission, requestingOrigin));
  const navigate = (event, url) => {
    const action = navigationAction(url, runtime.url);
    if (action !== 'internal') {
      event.preventDefault();
      if (action === 'external') shell.openExternal(url).catch(() => {});
    }
  };
  window.webContents.on('will-navigate', navigate);
  window.webContents.on('will-redirect', navigate);
  window.webContents.setWindowOpenHandler(({url}) => {
    const action = navigationAction(url, runtime.url);
    if (action === 'external') shell.openExternal(url).catch(() => {});
    else if (action === 'internal') window.loadURL(url);
    return {action: 'deny'};
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (process.platform === 'darwin' && !exiting) { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => { window = null; });
  window.loadURL(runtime.url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (runtime) showWindow(); });
  app.on('activate', () => { if (runtime) showWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', async event => {
    if (exiting) return;
    event.preventDefault();
    if (!await saveBeforeQuit()) return;
    exiting = true;
    await runtime?.close();
    app.exit(0);
  });
  app.whenReady().then(async () => {
    const settings = fs.existsSync(settingsPath()) ? JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) : {};
    const root = process.env.HORIZON_ROOT || settings.workspace || path.join(app.getPath('userData'), 'workspace');
    runtime = await startDesktopServer(root);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label: 'Horizon', submenu: [{role: 'about'}, {type: 'separator'}, {role: 'hide'}, {role: 'hideOthers'}, {role: 'unhide'}, {type: 'separator'}, {role: 'quit'}]},
      {label: 'Файл', submenu: [
        {label: 'Открыть рабочую папку…', accelerator: 'CmdOrCtrl+Shift+O', click: () => chooseWorkspace().catch(error => dialog.showErrorBox('Horizon', error.message))},
        {label: 'Показать рабочую папку в Finder', click: () => shell.openPath(runtime.root)}
      ]},
      {label: 'Правка', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
      {label: 'Вид', submenu: [{role: 'reload'}, {role: 'resetZoom'}, {role: 'zoomIn'}, {role: 'zoomOut'}, {role: 'togglefullscreen'}]},
      {label: 'Окно', submenu: [{role: 'minimize'}, {role: 'zoom'}, {role: 'front'}]},
      {label: 'Справка', submenu: [
        {label: 'Инструкция', click: () => shell.openExternal('https://github.com/gletushov/horizon/blob/main/docs/getting-started.md')},
        {label: 'Подключение агентов', click: () => shell.openExternal('https://github.com/gletushov/horizon/blob/main/docs/agents.md')},
        {label: 'Сообщить об ошибке', click: () => shell.openExternal('https://github.com/gletushov/horizon/issues/new?template=bug_report.yml')}
      ]}
    ]));
    showWindow();
  }).catch(error => {
    dialog.showErrorBox('Не удалось открыть Horizon', error.code === 'EADDRINUSE'
      ? 'Сохранённый порт занят. Закрой другой экземпляр Horizon и запусти приложение снова.' : error.message);
    exiting = true;
    app.exit(1);
  });
}
