import './public/planner-core.js';
import fs from 'node:fs';
import {rebaseManagedImages} from './daily-work-store.mjs';
import {History} from './history.mjs';
import {rememberFolder} from './document-workspace.mjs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const excluded = new Set(['node_modules','output','vendor','dist','build']);
const maxImportFiles=100,maxImportFileBytes=2_000_000,maxImportBytes=3_000_000;
const protectedMarkdownNames = new Set(['agents.md','claude.md','skill.md']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const hash = text => createHash('sha256').update(text).digest('hex');
const reviewColumns = {
  legacy: [
    {key: 'task', label: 'Theme', index: 0, owner: 'agent'},
    {key: 'updates', label: 'Agent comment', index: 1, owner: 'agent'},
    {key: 'comment', label: 'Letushv comment', index: 2, owner: 'user'}
  ],
  task: [
    {key: 'task', label: 'Task / session', index: 0, owner: 'agent'},
    {key: 'summary', label: 'Summary / purpose', index: 1, owner: 'agent'},
    {key: 'updates', label: 'Latest updates / next action', index: 2, owner: 'agent'},
    {key: 'comment', label: 'Letushv comments and decisions', index: 3, owner: 'user'}
  ]
};
const reviewSchema = (kind, labels = []) => {
  const task = kind === 'task-summary';
  const columns = (task ? reviewColumns.task : reviewColumns.legacy).map((column, index) => ({
    ...column,
    label: labels[index] || column.label
  }));
  return {
    version: task ? 2 : 1,
    kind,
    userColumn: 'comment',
    userColumnIndex: task ? 3 : 2,
    idPrefix: task ? 'T' : 'R',
    columns
  };
};
function cells(line) {
  const parts = []; let start = 0; let slashes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && slashes % 2 === 0) { parts.push(line.slice(start, i)); start = i + 1; }
    slashes = line[i] === '\\' ? slashes + 1 : 0;
  }
  parts.push(line.slice(start)); return parts;
}
const decode = text => text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/&#(\d+);|&amp;|&lt;|&gt;|\\\|/g, (s,n) => n ? String.fromCodePoint(Number(n)) : ({'&amp;':'&','&lt;':'<','&gt;':'>','\\|':'|'})[s]);
const encode = text => text.replace(/[&<>|\\\r\n]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','|':'&#124;','\\':'&#92;','\n':'<br>','\r':'&#13;'})[c]).replace(/(^ +| +$)/g,s=>'&#32;'.repeat(s.length));
const placeholder = raw => ['**','Ваш комментарий…'].includes(decode(raw.trim())) ? '' : decode(raw.trim());
const taskTitle = task => decode(String(task).trim()).replace(/^(?:R\d+|T\d+)\s*(?:[·.:-])?\s*/, '');
const lineCells = line => cells(line.replace(/\r$/, ''));
const lineEnding = line => line.endsWith('\r') ? '\r' : '';
function isTableDivider(parts, width) {
  return parts.length === width + 2 && parts[0].trim() === '' && parts.at(-1).trim() === '' && parts.slice(1, -1).every(part => /^\s*:?-{3,}:?\s*$/.test(part));
}
function headerLabels(lines, rowIndex, width) {
  for (let i = rowIndex - 2; i >= 0; i--) {
    const header = lineCells(lines[i]);
    const divider = lineCells(lines[i + 1] || '');
    if (header.length !== width + 2 || header[0].trim() || header.at(-1).trim() || !isTableDivider(divider, width)) continue;
    return header.slice(1, -1).map(cell => decode(cell.trim()));
  }
  return [];
}
function parseReview(content) {
  const rows = []; let fence = false; const lines = content.split('\n');
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const parts = lineCells(line);
    if (![5, 6].includes(parts.length) || parts[0].trim() || parts.at(-1).trim()) return;
    const width = parts.length - 2;
    const first = decode(parts[1].trim());
    const id = first.match(/^(R\d+|T\d+)\b/)?.[1];
    if (!id || (width === 3 && !id.startsWith('R')) || (width === 4 && !id.startsWith('T'))) return;
    const schema = width === 4 ? 'task-summary' : 'legacy-review';
    const task = first;
    const comment = placeholder(parts[1 + (width === 4 ? 3 : 2)]);
    if (schema === 'task-summary') {
      const summary = placeholder(parts[2]);
      const updates = placeholder(parts[3]);
      rows.push({id, task, taskTitle: taskTitle(task, id), theme: task, summary, updates, agent: updates, comment, userComment: comment, index, schema, agentContent: {task, summary, updates}});
    } else {
      const agent = placeholder(parts[2]);
      rows.push({id, theme: task, task, taskTitle: taskTitle(task, id), summary: '', updates: agent, agent, comment, userComment: comment, index, schema, agentContent: agent});
    }
  });
  const first = rows[0];
  if (!first) return {rows, schema: undefined};
  const labels = headerLabels(lines, first.index, first.schema === 'task-summary' ? 4 : 3);
  return {rows, schema: reviewSchema(first.schema, labels)};
}
function reviewTableSchema(content) {
  const lines = content.split('\n'); let fence = false;
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const header = lineCells(lines[i]); const width = header.length - 2;
    if (![3, 4].includes(width) || header[0]?.trim() || header.at(-1)?.trim() || !isTableDivider(lineCells(lines[i + 1]), width)) continue;
    const labels = header.slice(1, -1).map(cell => decode(cell.trim()));
    const lower = labels.map(label => label.toLowerCase());
    if (width === 4 && lower.some(label => label.includes('task')) && lower.some(label => label.includes('summary')) && lower.some(label => label.includes('update'))) return reviewSchema('task-summary', labels);
    if (width === 3 && lower.some(label => label === 'theme' || label.includes('тема')) && lower.some(label => label.includes('agent')) && lower.some(label => label.includes('comment'))) return reviewSchema('legacy-review', labels);
  }
  return undefined;
}
function schemaFor(content) {
  return parseReview(content).schema || reviewTableSchema(content);
}
function formatTask(id, value) {
  const title = taskTitle(value).trim();
  if (!title) fail('Укажите задачу');
  return `${id} · ${title}`;
}
function setLineCells(lines, row, updates) {
  const ending = lineEnding(lines[row.index]);
  const parts = lineCells(lines[row.index]);
  for (const [index, value] of updates) parts[index + 1] = ` ${encode(value)} `;
  lines[row.index] = parts.join('|') + ending;
}
function appendRows(lines, doc, rows) {
  const suffix = doc.content.includes('\r\n') ? '\r' : '';
  const values = rows.map(row => row + suffix);
  if (doc.rows.length) lines.splice(doc.rows.at(-1).index + 1, 0, ...values);
  else if (doc.reviewSchema) {
    const width = doc.reviewSchema.columns.length;
    for (let i = 0; i < lines.length - 1; i++) {
      if (isTableDivider(lineCells(lines[i]), width)) { lines.splice(i + 1, 0, ...values); return; }
    }
    lines.push(...values);
  } else {
    const columns = reviewColumns.legacy;
    lines.push('', '| ' + columns.map(column => column.label).join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |', ...values, '');
  }
}
function pathExists(file) {
  try { fs.lstatSync(file); return true; } catch(error) { if (error.code === 'ENOENT') return false; throw error; }
}
function importName(name) {
  if(typeof name!=='string'||!name||name.length>255||Buffer.byteLength(name)>255||name!==path.basename(name)||name.includes('\\')||name.includes('\0')||name.startsWith('.')||!name.endsWith('.md')) fail('Некорректное имя Markdown-файла');
  return name;
}
function horizonPath(relative) { return globalThis.HorizonPlanner.isPath(relative); }
function protectedPath(relative) {
  if (typeof relative !== 'string') return false;
  const normalized = relative.toLowerCase();
  return horizonPath(relative) || horizonPath(normalized) || normalized === 'reviews/agent-overview.md' || protectedMarkdownNames.has(path.basename(normalized));
}
export class Store {
  constructor(root) { this.root = fs.realpathSync(root); this.versions=new History(this.root);this.tracked=new Set();this.catalogue=null; }
  validate(relative) {
    if (typeof relative !== 'string' || !/\.(md|html)$/.test(relative) || relative.includes('\\') || relative.split('/').some(p=>!p || p.startsWith('.') || excluded.has(p))) fail('Недоступный путь',403);
    return relative.split('/');
  }
  validateDirectory(relative) {
    if(typeof relative!=='string'||(relative&&(relative.includes('\\')||relative.split('/').some(part=>!part||part.startsWith('.')||excluded.has(part))))) fail('Недоступная папка',403);
    return relative ? relative.split('/') : [];
  }
  resolve(relative, create=false) {
    const parts=this.validate(relative);let cursor=this.root;
    for(let i=0;i<parts.length;i++) {
      cursor=path.join(cursor,parts[i]);
      if(!fs.existsSync(cursor)) {
        if(!create)fail('Файл не найден',404);
        if(i<parts.length-1)fs.mkdirSync(cursor);else return cursor;
      }
      if(fs.lstatSync(cursor).isSymbolicLink())fail('Ссылки на файлы не подключены',403);
      if(i<parts.length-1 && !fs.statSync(cursor).isDirectory())fail('Это не папка');
    }
    if(!fs.statSync(cursor).isFile())fail('Это не файл');
    return cursor;
  }
  resolveDirectory(relative='') {
    const parts=this.validateDirectory(relative);let cursor=this.root;
    for(const part of parts){cursor=path.join(cursor,part);if(!pathExists(cursor))fail('Папка не найдена',404);if(fs.lstatSync(cursor).isSymbolicLink())fail('Ссылки на папки не подключены',403);if(!fs.statSync(cursor).isDirectory())fail('Это не папка');}
    return cursor;
  }
  list() {
    if(this.catalogue && Date.now()-this.catalogue.time<5000)return this.catalogue.docs;
    // ponytail: rg skips ignored dependency trees; no content scan of every worktree.
    const result=spawnSync('rg',['--files','--hidden','--no-ignore-parent','-g','*.md','-g','*.html','-g','!**/.*/**','-g','!**/node_modules/**','-g','!**/output/**','-g','!**/vendor/**','-g','!**/dist/**','-g','!**/build/**'],{cwd:this.root,encoding:'utf8',maxBuffer:32_000_000,timeout:15000});
    let names=[];
    if(!result.error&&[0,1].includes(result.status))names=result.stdout.trim().split('\n').filter(Boolean);
    else {const walk=dir=>{for(const entry of fs.readdirSync(path.join(this.root,dir),{withFileTypes:true})){if(entry.name.startsWith('.')||excluded.has(entry.name)||entry.isSymbolicLink())continue;const name=dir?dir+'/'+entry.name:entry.name;if(entry.isDirectory())walk(name);else if(entry.isFile()&&/\.(md|html)$/.test(name))names.push(name);}};walk('');}
    const docs=names.filter(name=>!name.split('/').some(part=>part.startsWith('.'))).map(name=>({path:name,title:path.basename(name,path.extname(name)).replace(/[-_]/g,' '),format:name.endsWith('.html')?'html':'markdown',editable:!name.endsWith('.html'),group:name.split('/').includes('reviews')?'reviews':name.split('/')[0],reviewCount:0}));
    // Read titles only for small catalogues; large project trees remain cheap to open.
    if(docs.length<1000)for(const doc of docs){try{const source=this.read(doc.path,'external',false);doc.title=source.title;doc.reviewCount=source.rows.length;if(source.rows.length)doc.group='reviews';}catch{}}
    docs.sort((a,b)=>a.path.localeCompare(b.path));this.catalogue={time:Date.now(),docs};return docs;
  }
  observeOpen(){for(const relative of this.tracked){try{this.read(relative);}catch{}}}
  read(relative,actor='external',track=true) {
    const file = this.resolve(relative);
    if (fs.statSync(file).size > 2_000_000) fail('Файл больше 2 МБ',413);
    const content = fs.readFileSync(file,'utf8');
    const html=relative.endsWith('.html'),parsed=html?{rows:[]}:parseReview(content);const doc={path:relative, title:(html?content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g,'').trim():content.match(/^#\s+(.+)$/m)?.[1]?.trim()) || path.basename(relative,path.extname(relative)), format:html?'html':'markdown', content, modifiedAt:fs.statSync(file).mtime.toISOString(), revision:hash(content), rows:parsed.rows, editable:!html, fileOperationsProtected:protectedPath(relative)};
    const schema=html?null:parsed.schema || reviewTableSchema(content);if(schema)doc.reviewSchema=schema;
    if(!track)return doc;this.tracked.add(relative);return this.versions.observe(doc,actor);
  }
  write(relative, revision, content,actor='agent') {
    if(relative?.endsWith('.html'))fail('HTML доступен для чтения. Редактируйте исходный файл.',403);
    if (typeof content !== 'string' || Buffer.byteLength(content) > 2_000_000) fail('Некорректный размер документа',413);
    const current = this.read(relative);
    if (current.revision !== revision) fail('Файл изменился на диске. Скопируйте черновик и загрузите свежую версию для сравнения.',409);
    const file = this.resolve(relative);
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp,content,{mode:fs.statSync(file).mode & 0o777,flag:'wx'});
      if (hash(fs.readFileSync(file,'utf8')) !== revision) fail('Файл изменился во время сохранения. Черновик остался в браузере.',409);
      fs.renameSync(temp,file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return this.read(relative,actor);
  }
  save(relative, revision, content) {
    return this.write(relative,revision,content,'user');
  }
  create(relative,content) {
    this.catalogue=null;
    if(typeof content!=='string' || Buffer.byteLength(content)>2_000_000)fail('Некорректный документ',413);
    const file=this.resolve(relative,true);
    if(fs.existsSync(file))fail('Файл уже существует',409);
    fs.writeFileSync(file,content,{flag:'wx',mode:0o600});return this.read(relative,'user');
  }
  importDocuments(destination,files) {
    const directory=this.resolveDirectory(destination);
    if(!Array.isArray(files)||!files.length||files.length>maxImportFiles)fail('Ожидается список Markdown-файлов');
    const names=new Set(),entries=[];let total=0;
    for(const file of files){
      if(!file||typeof file!=='object'||Array.isArray(file)||typeof file.content!=='string')fail('Некорректное содержимое Markdown-файла');
      const name=importName(file.name);if(names.has(name))fail('Повторяющееся имя файла');names.add(name);
      const bytes=Buffer.byteLength(file.content,'utf8');if(bytes>maxImportFileBytes)fail('Файл больше 2 МБ',413);total+=bytes;if(total>maxImportBytes)fail('Импорт больше 3 МБ',413);
      const target=path.join(directory,name);if(pathExists(target))fail('Файл уже существует: '+name,409);entries.push({name,content:file.content,target});
    }
    const staged=[],created=[];
    try {
      for(const entry of entries){const stagedEntry={temp:path.join(directory,'.'+entry.name+'.'+randomUUID()+'.tmp'),target:entry.target};staged.push(stagedEntry);fs.writeFileSync(stagedEntry.temp,entry.content,{mode:0o600,flag:'wx'});}
      for(const entry of staged){fs.linkSync(entry.temp,entry.target);created.push(entry.target);fs.unlinkSync(entry.temp);}
      this.catalogue=null;
      return entries.map(entry=>this.read(path.relative(this.root,entry.target),'user'));
    } catch(error) {
      for(const entry of staged){try{if(pathExists(entry.temp))fs.unlinkSync(entry.temp);}catch{}}
      for(const target of created){try{if(pathExists(target))fs.unlinkSync(target);}catch{}}
      throw error;
    }
  }
  remove(relative,revision) {
    this.catalogue=null;
    const doc=this.read(relative);if(doc.revision!==revision)fail('Файл изменился. Обновите документ перед удалением.',409);
    if(protectedPath(relative))fail(horizonPath(relative) ? 'Документ горизонта можно редактировать, но нельзя удалять.' : 'Служебный документ нельзя удалять.');
    rememberFolder(this,path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative));
    const id=randomUUID(), dir=path.join(this.root,'.trash',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(dir,'record.json'),JSON.stringify({path:relative,deletedAt:new Date().toISOString()}),{mode:0o600});
    fs.renameSync(this.resolve(relative),path.join(dir,'document.md'));this.versions.move(relative,'deleted/'+id+'/'+relative);return {id,path:relative};
  }
  restore(id) {
    if(typeof id!=='string' || !/^[a-f0-9-]{36}$/.test(id))fail('Некорректная запись корзины');
    const dir=path.join(this.root,'.trash',id);
    if(!fs.existsSync(path.join(dir,'document.md')))fail('Документ в корзине не найден',404);
    const record=JSON.parse(fs.readFileSync(path.join(dir,'record.json'),'utf8'));
    const doc=this.create(record.path,fs.readFileSync(path.join(dir,'document.md'),'utf8'));
    fs.unlinkSync(path.join(dir,'document.md'));this.versions.move('deleted/'+id+'/'+record.path,record.path);return this.read(record.path,'user');
  }
  rename(relative,revision,destination) {
    this.catalogue=null;
    const doc=this.read(relative);if(doc.revision!==revision)fail('Файл изменился. Обновите документ.',409);
    this.validate(destination);if(path.extname(relative)!==path.extname(destination))fail('Сохраните расширение документа');
    if(protectedPath(relative))fail(horizonPath(relative) ? 'Имя документа горизонта закреплено.' : 'Служебный документ нельзя переименовать.');
    if(protectedPath(destination))fail('Служебный документ нельзя заменить переименованием.');
    const file=this.resolve(destination,true);if(fs.existsSync(file))fail('Файл уже существует',409);
    rememberFolder(this,path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative));
    const content=relative.endsWith('.md')?rebaseManagedImages(doc.content,relative,destination):doc.content;
    if(content===doc.content)fs.linkSync(this.resolve(relative),file);else fs.writeFileSync(file,content,{flag:'wx'});fs.unlinkSync(this.resolve(relative));this.versions.move(relative,destination);return this.read(destination);
  }
  addRow(relative,revision,theme,comment='') {
    const doc=this.read(relative);
    if(typeof theme!=='string' || !theme.trim() || theme.length>1000 || typeof comment!=='string' || comment.length>50_000)fail('Укажите тему и комментарий');
    const schema=doc.reviewSchema || schemaFor(doc.content);const task=schema?.kind==='task-summary';
    const prefix=task?'T':'R';const id=prefix+String(Math.max(0,...doc.rows.filter(row=>row.id.startsWith(prefix)).map(row=>Number(row.id.slice(1))))+1).padStart(2,'0');
    const title=task?taskTitle(theme).trim():theme.trim();if(task&&!title)fail('Укажите задачу');
    const row=task
      ? `| ${id} · ${encode(title)} | ** | Новая задача пользователя. Ожидает разбора агентом. | ${comment?encode(comment):'**'} |`
      : `| ${id} · ${encode(theme.trim())} | Новая тема пользователя. Ожидает разбора агентом. | ${comment?encode(comment):'**'} |`;
    const lines=doc.content.split('\n');
    appendRows(lines,{...doc,reviewSchema:schema},[row]);
    return this.write(relative,revision,lines.join('\n'),'user');
  }
  moveTask(source,revision,index,destination,targetRevision,before=null,id=null,beforeId=null) {
    if(!horizonPath(source) || !horizonPath(destination))fail('Перенос доступен между горизонтами');
    const from=this.read(source),to=this.read(destination);
    if(from.revision!==revision || to.revision!==targetRevision)fail('План изменился. Обновите горизонты.',409);
    const tasks=globalThis.HorizonPlanner.tasks;
    if(id){const matches=tasks(from.content).filter(t=>t.id===id);if(matches.length!==1||matches[0].invalid)fail('Задача исчезла или ID неоднозначен.',409);index=matches[0].index;if(source!==destination&&tasks(to.content).some(t=>t.id===id))fail('ID задачи найден в обоих горизонтах. Проверьте оба файла.',409);}
    if(beforeId){const matches=tasks(to.content).filter(t=>t.id===beforeId);if(matches.length!==1)fail('Место вставки изменилось.',409);before=matches[0].index;}
    const lines=from.content.split('\n');
    if(!Number.isInteger(index) || !/^[-*] \[[ xX]\] /.test(lines[index]||''))fail('Переносите задачу верхнего уровня');
    let end=index+1;while(end<lines.length && (/^\s+\S/.test(lines[end]) || !lines[end].trim()))end++;
    const block=lines.slice(index,end);
    const targetLines=source===destination?lines:to.content.split('\n');
    if(before!==null && (!Number.isInteger(before) || !/^[-*] \[[ xX]\] /.test(targetLines[before]||'')))fail('Место вставки изменилось',409);
    if(source===destination) {
      if(before!==null && before>=index && before<end)return from;
      lines.splice(index,end-index);let at=before===null?lines.length:before>index?before-(end-index):before;
      lines.splice(at,0,...block);return this.write(source,revision,lines.join('\n'));
    }
    lines.splice(index,end-index);targetLines.splice(before===null?targetLines.length:before,0,...block);
    const saved=this.write(destination,targetRevision,targetLines.join('\n'));
    try {this.write(source,revision,lines.join('\n'));}
    catch(error){try{this.write(destination,saved.revision,to.content);}catch{fail('Перенос прерван. Задача осталась в обоих горизонтах; проверьте их.',409);}throw error;}
    return {ok:true,source:this.read(source),destination:this.read(destination)};
  }
  deleteTask(relative,revision,index) {
    if(relative&&typeof relative==='object'){({path:relative,revision,index}=relative);}
    if(!horizonPath(relative))fail('Удаление доступно для горизонтов');
    const doc=this.read(relative);if(doc.revision!==revision)fail('План изменился. Обновите горизонт.',409);
    const lines=doc.content.split('\n');if(!Number.isInteger(index)||!/^[-*] \[[ xX]\] /.test(lines[index]||''))fail('Удаляйте задачу верхнего уровня');
    let end=index+1;while(end<lines.length&&(/^\s+\S/.test(lines[end])||!lines[end].trim()))end++;
    const block=lines.slice(index,end);const state=this.versions.state(relative);const undoVersion=state.revision===revision&&state.latestVersion?state.latestVersion:this.versions.list(relative).find(version=>version.revision===revision)?.id || null;lines.splice(index,end-index);this.catalogue=null;
    const saved=this.write(relative,revision,lines.join('\n'),'user');return {...saved,ok:true,deleted:{index,content:block.join('\n')},undoVersion};
  }
  removeTask(...args) { return this.deleteTask(...args); }
  agentReview(relative,revision,changes,transform=null){
    const doc=this.read(relative);if(doc.revision!==revision)fail('Ревью изменилось. Перечитайте файл перед ответом.',409);
    if(!Array.isArray(changes)||!changes.length||changes.length>100)fail('Ожидается список изменений');
    const schema=doc.reviewSchema || schemaFor(doc.content);const task=schema?.kind==='task-summary';
    const lines=doc.content.split('\n'),used=new Set(),patches=[],added=[];const prefix=task?'T':'R';
    let next=Math.max(0,...doc.rows.filter(row=>row.id.startsWith(prefix)).map(row=>Number(row.id.slice(1))));
    for(const change of changes){
      if(!change || typeof change!=='object' || Array.isArray(change))fail('Некорректный ответ агента');
      const hasId=Object.hasOwn(change,'id')&&change.id!==undefined&&change.id!==null;
      if(hasId){
        if(typeof change.id!=='string'||!change.id||used.has(change.id))fail('Повторяющийся ID');
        used.add(change.id);const row=doc.rows.find(candidate=>candidate.id===change.id);if(!row)fail('Строка не найдена: '+change.id);
        const updates=[];
        if(task){
          const taskKey=Object.hasOwn(change,'task')?'task':Object.hasOwn(change,'theme')?'theme':null;
          const summaryKey=Object.hasOwn(change,'summary')?'summary':Object.hasOwn(change,'purpose')?'purpose':null;
          const updatesKey=Object.hasOwn(change,'updates')?'updates':Object.hasOwn(change,'agent')?'agent':null;
          if(taskKey){if(typeof change[taskKey]!=='string'||change[taskKey].length>1000)fail('Некорректная задача');updates.push([0,formatTask(row.id,change[taskKey])]);}
          if(summaryKey){if(typeof change[summaryKey]!=='string'||change[summaryKey].length>100000)fail('Некорректное резюме');updates.push([1,change[summaryKey]]);}
          if(updatesKey){if(typeof change[updatesKey]!=='string'||change[updatesKey].length>100000)fail('Некорректное обновление агента');updates.push([2,change[updatesKey]]);}
          if(!updates.length)fail('Укажите поле агента');
        } else {
          if(typeof change.agent!=='string'||change.agent.length>100000)fail('Некорректный ответ агента');
          updates.push([1,change.agent]);
        }
        patches.push({row,updates});
      } else if(task){
        const taskValue=Object.hasOwn(change,'task')?change.task:change.theme;
        if(typeof taskValue!=='string'||!taskValue.trim()||taskValue.length>1000)fail('Укажите новую задачу');
        const summaryKey=Object.hasOwn(change,'summary')?'summary':Object.hasOwn(change,'purpose')?'purpose':null;
        const updatesKey=Object.hasOwn(change,'updates')?'updates':Object.hasOwn(change,'agent')?'agent':null;
        const summary=summaryKey?change[summaryKey]:'';const updates=updatesKey?change[updatesKey]:'Ожидает разбора агентом.';
        if(typeof summary!=='string'||summary.length>100000)fail('Некорректное резюме');
        if(typeof updates!=='string'||updates.length>100000)fail('Некорректное обновление агента');
        const id='T'+String(++next).padStart(2,'0');
        added.push(`| ${id} · ${encode(taskTitle(taskValue).trim())} | ${summary?encode(summary):'**'} | ${updates?encode(updates):'**'} | ** |`);
      } else {
        if(typeof change.theme!=='string'||!change.theme.trim()||change.theme.length>1000)fail('Укажите новую тему');
        if(typeof change.agent!=='string'||change.agent.length>100000)fail('Некорректный ответ агента');
        const id='R'+String(++next).padStart(2,'0');added.push(`| ${id} · ${encode(change.theme.trim())} | ${encode(change.agent)} | ** |`);
      }
    }
    for(const patch of patches)setLineCells(lines,patch.row,patch.updates);
    if(added.length)appendRows(lines,{...doc,reviewSchema:schema},added);
    const content=lines.join('\n');
    const saved=this.write(relative,revision,transform?transform(content):content,'agent');
    const started=changes.filter(change=>change.id && /^\*\*In progress\./i.test(change.updates||change.agent||'') && (!change.replyTo || change.replyTo===hash(JSON.stringify(saved.rows.find(row=>row.id===change.id)?.comment))));
    if(started.length){const state=this.versions.state(relative);for(const change of started){const row=saved.rows.find(row=>row.id===change.id);if(row?.comment&&state.rows[row.id])state.rows[row.id].inProgressComment=row.comment;}this.versions.saveState(relative,state);}
    const acknowledged=changes.filter(change=>change.id && change.acknowledgeComment===true);
    if(acknowledged.length){const state=this.versions.state(relative);for(const change of acknowledged){const row=saved.rows.find(row=>row.id===change.id);if(row?.comment && state.rows[row.id])state.rows[row.id].acknowledgedComment=row.comment;}this.versions.saveState(relative,state);return this.read(relative);}
    return started.length?this.read(relative):saved;
  }
  history(relative){this.read(relative);return this.versions.list(relative);}
  version(relative,id){this.resolve(relative);return this.versions.version(relative,id);}
  rowState(relative,revision,id,action){const doc=this.read(relative);if(doc.revision!==revision)fail('Файл изменился. Обновите документ перед изменением статуса.',409);this.versions.mark(doc,id,action);return this.read(relative);}
  restoreVersion(relative,revision,id,scope='agent',rowId=null){
    const doc=this.read(relative);if(doc.revision!==revision)fail('Файл изменился. Обновите документ перед откатом.',409);
    const old=this.version(relative,id);if(scope==='document')return this.write(relative,revision,old.content,'restore');
    if(scope!=='agent')fail('Неизвестный способ восстановления');
    const previous=parseReview(old.content).rows,lines=doc.content.split('\n');let count=0;
    for(const row of doc.rows){
      if(rowId&&row.id!==rowId)continue;
      const prev=previous.find(candidate=>candidate.id===row.id);if(!prev)continue;
      if(row.schema==='task-summary'&&prev.schema==='task-summary')setLineCells(lines,row,[[0,formatTask(row.id,prev.task)],[1,prev.summary],[2,prev.updates]]);
      else if(row.schema==='legacy-review'&&prev.schema==='legacy-review')setLineCells(lines,row,[[1,prev.agent]]);
      else continue;
      count++;
    }
    if(!count)fail('В этой версии нет выбранных строк');return this.write(relative,revision,lines.join('\n'),'restore');
  }
  comment(relative, revision, edits) {
    const current = this.read(relative);
    if (current.revision !== revision) fail('Файл изменился на диске. Скопируйте черновик и загрузите свежую версию для сравнения.',409);
    if (!Array.isArray(edits) || !edits.length || edits.length > 500) fail('Выберите изменённые комментарии');
    if (edits.some(edit => !edit || typeof edit !== 'object' || Array.isArray(edit) || typeof edit.id !== 'string')) fail('Некорректный комментарий');
    if (new Set(current.rows.map(r=>r.id)).size !== current.rows.length) fail('В таблице повторяются ID строк. Исправьте их в исходном файле.');
    if (new Set(edits.map(e=>e.id)).size !== edits.length) fail('Повторяющиеся ID в изменениях');
    const lines = current.content.split('\n');
    for (const edit of edits) {
      if (typeof edit.comment !== 'string' || edit.comment.length > 50_000) fail('Комментарий слишком длинный');
      const row = current.rows.find(r=>r.id===edit.id);
      if (!row) fail('Строка не найдена: ' + edit.id);
      setLineCells(lines,row,[[current.reviewSchema?.userColumnIndex ?? (row.schema==='task-summary'?3:2),edit.comment || '**']]);
    }
    return this.write(relative,revision,lines.join('\n'),'user');
  }
}

export {parseReview, encode, setLineCells, appendRows};
