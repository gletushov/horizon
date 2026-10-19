import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeProject} from './project-layout.mjs';
import {prepareDispatch} from './agent-dispatch.mjs';
import {CodexBridge} from './codex-bridge.mjs';
import {WorkspaceStore} from './workspace-store.mjs';
import {readDay,saveDay,editTask} from './planner-store.mjs';
import {documentPreview} from './document-preview.mjs';
import {readNotes,actNotes,uploadImage,sessions,rebaseManagedImages} from './daily-work-store.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export function createApp(root = here) {
  const store = new WorkspaceStore(root);const codex=new CodexBridge(root);
  const assets = {'/daily-work.js':'public/daily-work.js','/editor-core.js':'public/editor-core.js','/document-comments.js':'public/document-comments.js','/document-tree.js':'public/document-tree.js','/review.js':'public/review.js','/review.css':'public/review.css','/theme.js':'public/theme.js','/':'public/index.html','/favicon.svg':'public/favicon.svg','/app.js':'public/app.js','/style.css':'public/style.css','/visual.js':'public/visual.js','/planner-core.js':'public/planner-core.js','/vendor/turndown.js':'node_modules/turndown/dist/turndown.js','/vendor/gfm.js':'node_modules/turndown-plugin-gfm/dist/turndown-plugin-gfm.js','/vendor/marked.js':'node_modules/marked/lib/marked.umd.js','/vendor/purify.js':'node_modules/dompurify/dist/purify.min.js'};
  const server=http.createServer(async (req,res) => {
    const json = (code,data) => {res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const host = req.headers.host;
    if (![`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(host)) return json(403,{error:'Недоступный адрес сервера'});
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403,{error:'Запрос с другого сайта запрещён'});
    try {
      const url = new URL(req.url,`http://${host}`);
      if(req.method==='GET'&&url.pathname.startsWith('/document-preview/')) {
        const preview=documentPreview(store,decodeURIComponent(url.pathname.slice('/document-preview/'.length)));
        res.setHeader('Content-Type',preview.type);
        res.setHeader('Content-Security-Policy',"sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        res.end(preview.content);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/notes')return json(200,readNotes(store));
      if(req.method==='GET'&&url.pathname==='/api/sessions'){const result=sessions(store);if(url.searchParams.get('discover')==='1'){for(const project of store.roots()){try{const listed=await codex.list(project.path);for(const thread of listed.threads)if(!result.sessions.some(s=>s.projectId===project.id&&s.provider==='codex'&&s.sessionId===thread.id))result.sessions.push({projectId:project.id,provider:'codex',sessionId:thread.id,title:thread.title,taskIds:[]});}catch(error){result.warning='Часть сессий Codex недоступна. Зарегистрированные сессии сохранены.';}}}return json(200,result);}
      if(req.method==='GET'&&url.pathname==='/api/review')return json(200,store.review.read());
      if(req.method==='GET'&&url.pathname==='/api/review/history')return json(200,store.review.history(url.searchParams.get('id')));
      if(req.method==='GET'&&url.pathname==='/api/health')return json(200,{app:'LetHorizon'});
      if (req.method === 'GET' && url.pathname === '/api/planner/day') return json(200,readDay(store.local,url.searchParams.get('date')));
      if (req.method === 'GET' && url.pathname === '/api/documents') return json(200,{documents:store.list(),projects:store.roots()});
      if (req.method === 'GET' && url.pathname === '/api/agent-inbox') return json(200,store.agentInbox(url.searchParams.get('all')==='1'));
      if(req.method==='GET' && url.pathname==='/api/codex/status')return json(200,await codex.status());
      if(req.method==='GET' && url.pathname==='/api/codex/dispatch-status')return json(200,codex.getRecord(url.searchParams.get('id')));
      if(req.method==='GET' && url.pathname==='/api/codex/threads'){const target=store.target(url.searchParams.get('path'));try{return json(200,await codex.list(target.store.root));}catch(error){return json(200,{available:false,error:error.message,threads:[]});}}
      if(req.method==='GET'&&url.pathname==='/api/history')return json(200,{versions:store.history(url.searchParams.get('path'))});
      if(req.method==='GET'&&url.pathname==='/api/version')return json(200,store.version(url.searchParams.get('path'),url.searchParams.get('id')));
      if (req.method === 'GET' && url.pathname === '/api/document') return json(200,store.read(url.searchParams.get('path')));
      if(req.method==='GET'&&url.pathname==='/api/annotations')return json(200,store.annotations(url.searchParams.get('path')));
      if(req.method==='GET'&&url.pathname==='/api/annotations/export')return json(200,store.exportAnnotations(url.searchParams.get('path')));
      if(req.method==='GET'&&url.pathname==='/api/folders')return json(200,{folders:store.folders()});
      if(req.method==='GET'&&url.pathname==='/api/folder')return json(200,store.folder(url.searchParams.get('path')));
      if(req.method==='POST'&&['/api/annotations','/api/folder'].includes(url.pathname)) {
        if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'Ожидается JSON'});
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>300_000)return json(413,{error:'Слишком большой запрос'});chunks.push(chunk);}
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return json(200,url.pathname==='/api/annotations'?store.annotations(data.path,data):store.folder(data.action==='restore'?(data.projectId?'projects/'+data.projectId+'/':''):data.path,data));
      }
      if (req.method === 'POST' && ['/api/images','/api/notes','/api/sessions','/api/review/note','/api/review','/api/review/brief','/api/review/send','/api/planner/task','/api/planner/day','/api/document','/api/comments','/api/create','/api/delete','/api/restore','/api/rename','/api/row','/api/move-task','/api/delete-task','/api/import','/api/agent-session','/api/agent-inbox/read','/api/codex/send','/api/codex/preview','/api/codex/dispatch','/api/row-state','/api/restore-version','/api/connect-project'].includes(url.pathname)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415,{error:'Ожидается JSON'});
        const chunks = []; let size = 0;const bodyLimit=url.pathname==='/api/images'?14_500_000:url.pathname==='/api/import'?8_000_000:3_000_000;
        for await (const chunk of req) { size += chunk.length; if (size > bodyLimit) {json(413,{error:'Слишком большой запрос'}); return;} chunks.push(chunk); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(url.pathname==='/api/images')return json(200,uploadImage(store,data));
        if(url.pathname==='/api/notes')return json(200,actNotes(store,data));
        if(url.pathname==='/api/sessions')return json(200,sessions(store,data));
        if(url.pathname==='/api/review/note')return json(200,store.review.note(data));
        if(url.pathname==='/api/review')return json(200,store.review.act(data));
        if(url.pathname==='/api/review/brief'){const brief=store.review.brief(data);return json(200,{...brief,previous:brief.delivery==='codex'?codex.getRecord(brief.requestId):null});}
        if(url.pathname==='/api/review/send'){const brief=store.review.brief(data);if(brief.delivery!=='codex')return json(409,{error:'Автоматическая доставка недоступна; скопируйте поручение'});if(brief.requestId!==data.requestId)return json(409,{error:'Поручение или исполнитель изменились. Подготовьте отправку заново.'});const record=await codex.send(brief,brief.cwd);store.review.recordDelivery(brief,record);return json(200,record);}
        if(url.pathname==='/api/planner/task')return json(200,editTask(store.local,data));
        if(url.pathname==='/api/planner/day')return json(200,saveDay(store.local,data));
        if(url.pathname==='/api/connect-project'){const project=store.connect(data.name,data.directory);if(data.initialize===true){try{project.created=initializeProject(project.path);}catch(error){project.warning='Project connected, but layout is incomplete: '+error.message;}}return json(200,project);}
        if(url.pathname==='/api/import')return json(200,{documents:store.importDocuments(data.destination,data.files)});
        if(url.pathname==='/api/agent-session')return json(200,store.registerAgentSession(data));
        if(url.pathname==='/api/agent-inbox/read')return json(200,store.markAgentInboxRead(data?.id,data?.version));
        if(url.pathname==='/api/row-state')return json(200,store.rowState(data.path,data.revision,data.id,data.action));
        if(url.pathname==='/api/restore-version')return json(200,store.restoreVersion(data.path,data.revision,data.id,data.scope,data.rowId));
        if(url.pathname==='/api/codex/preview')return json(200,{tasks:prepareDispatch(store,codex,data.ids)});
        if(url.pathname==='/api/codex/dispatch'){const task=prepareDispatch(store,codex,[data.id])[0];if(task.error)return json(409,{error:task.error});if(task.requestId!==data.requestId)return json(409,{error:'Comment or task changed. Refresh preview before sending.'});return json(200,await codex.send(task,task.cwd));}
        if(url.pathname==='/api/codex/send'){store.read(data.path);return json(200,await codex.send(data,store.target(data.path).store.root));}
        if(url.pathname==='/api/create'){let content=data.content;if(data.sourcePath!==undefined){store.read(data.sourcePath);const source=store.target(data.sourcePath),destination=store.target(data.path);if(source.store!==destination.store)throw Object.assign(new Error('Создание из заметки доступно внутри её проекта'),{status:400});content=rebaseManagedImages(content,source.relative,destination.relative);}return json(200,store.create(data.path,content));}
        if(url.pathname==='/api/delete')return json(200,store.remove(data.path,data.revision));
        if(url.pathname==='/api/restore')return json(200,store.restore(data.id,data.projectId));
        if(url.pathname==='/api/rename')return json(200,store.rename(data.path,data.revision,data.destination));
        if(url.pathname==='/api/row')return json(200,store.addRow(data.path,data.revision,data.theme,data.comment));
        if(url.pathname==='/api/move-task')return json(200,store.moveTask(data));
        if(url.pathname==='/api/delete-task')return json(200,store.deleteTask(data.path,data.revision,data.index));
        return json(200,url.pathname === '/api/comments' ? store.comment(data.path,data.revision,data.edits) : store.save(data.path,data.revision,data.content));
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        const asset = assets[url.pathname];
        res.setHeader('Content-Type',asset.endsWith('.svg') ? 'image/svg+xml' : asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.end(fs.readFileSync(path.join(here,asset))); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
        const name = decodeURIComponent(url.pathname.slice('/fonts/'.length));
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return json(404,{error:'Не найдено'});
        const asset = path.join(here,'public','fonts',name);
        if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) return json(404,{error:'Не найдено'});
        res.setHeader('Content-Type',name.endsWith('.woff2') ? 'font/woff2' : 'text/plain; charset=utf-8');
        res.end(fs.readFileSync(asset)); return;
      }
      if (url.pathname === '/favicon.ico') {res.writeHead(204);res.end();return;}
      json(404,{error:'Не найдено'});
    } catch (error) {json(error.status || (error instanceof SyntaxError ? 400 : 500),{error:error.status || error instanceof SyntaxError ? error.message : 'Не удалось обработать файл. Проверьте доступ и место на диске.'});}
  });
  const observer=setInterval(()=>{try{store.local.observeOpen();store.projects.forEach(p=>p.store.observeOpen());}catch{}},10000);observer.unref();server.on('close',()=>{clearInterval(observer);codex.close();});server.codex=codex;return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317); const server = createApp(process.env.HORIZON_ROOT || here);
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  server.listen(port,'127.0.0.1',async()=>{fs.mkdirSync(path.join(process.env.HORIZON_ROOT||here,'.runtime'),{recursive:true});fs.writeFileSync(path.join(process.env.HORIZON_ROOT||here,'.runtime',`server-${port}.pid`),String(process.pid));console.log(`LetHorizon: http://127.0.0.1:${port}`);if(process.env.HORIZON_CODEX_AUTOSTART!=='0'){const result=await server.codex.status();console.log(result.available?'Codex: connected ('+result.mode+')':'Codex: '+result.error);}});
  const stop=()=>{server.codex.close();server.close(()=>process.exit(0));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
