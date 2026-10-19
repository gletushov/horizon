import fs from 'node:fs';
import path from 'node:path';
import {createApp} from '../server.mjs';

export async function startDesktopServer(root) {
  root = path.resolve(root);
  fs.mkdirSync(root, {recursive: true});
  const review = path.join(root, 'reviews', 'agent-overview.md');
  fs.mkdirSync(path.dirname(review), {recursive: true});
  if (!fs.existsSync(review)) fs.writeFileSync(review,
    '# Agents\n\n| Task / session | Summary / purpose | Latest updates / next action | Your comments and decisions |\n|---|---|---|---|\n', {flag: 'wx'});
  const runtime = path.join(root, '.runtime');
  fs.mkdirSync(runtime, {recursive: true});
  const portFile = path.join(runtime, 'desktop-port.json');
  const port = fs.existsSync(portFile) ? JSON.parse(fs.readFileSync(portFile, 'utf8')).port : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Некорректный сохранённый порт Horizon');
  const server = createApp(root);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    fs.writeFileSync(portFile, JSON.stringify({port: server.address().port}) + '\n', {mode: 0o600});
  } catch (error) {
    server.close();
    throw error;
  }
  return {root, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve))};
}

export function navigationAction(url, origin) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'blocked'; }
  if (parsed.origin === origin) return 'internal';
  if (parsed.protocol === 'codex:' && parsed.hostname === 'threads' && !parsed.username && !parsed.password &&
      /^\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(parsed.pathname) && !parsed.search && !parsed.hash) return 'external';
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'blocked';
  if (parsed.hostname === 'localhost' || parsed.hostname.startsWith('127.') || parsed.hostname === '[::1]') return 'blocked';
  return 'external';
}
