import fs from 'node:fs';
import {rebaseManagedImages} from './daily-work-store.mjs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedFile=relative=>{const normalized=relative.toLowerCase();return /^planner\/(day|week|month|quarter|year|future|life)\.md$/.test(normalized)||normalized==='reviews/agent-overview.md'||/^(agents|claude|skill)\.md$/.test(path.basename(normalized));};
const present=file=>{try{fs.lstatSync(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export function annotations(store,relative) {
  const doc=store.read(relative),state=store.versions.state(relative);
  return {path:relative,revision:hash([state.annotations||[],state.deletedAnnotations||[]]),sourceRevision:doc.revision,comments:state.annotations||[]};
}
export function annotate(store,relative,data) {
  const current=annotations(store,relative);if(data.revision!==current.revision)fail('Обсуждение изменилось. Перечитайте комментарии.',409);
  const state=store.versions.state(relative);state.annotations||=[];state.deletedAnnotations||=[];
  const index=state.annotations.findIndex(c=>c.id===data.id);
  const text=()=>{if(typeof data.text!=='string'||!data.text.trim()||data.text.length>50_000)fail('Напишите комментарий до 50 000 знаков');return data.text.trim();};
  if(data.action==='add') {
    if(data.sourceRevision!==current.sourceRevision)fail('Текст изменился. Выделите цитату в свежей версии.',409);
    if(typeof data.quote!=='string'||!data.quote.trim()||data.quote.length>50_000)fail('Выделите цитату до 50 000 знаков');
    if(state.annotations.length>=1000)fail('В документе уже 1000 комментариев',413);
    for(const k of ['prefix','suffix'])if(data[k]!==undefined&&(typeof data[k]!=='string'||data[k].length>1000))fail('Некорректный контекст цитаты');
    state.annotations.push({id:randomUUID(),quote:data.quote,prefix:data.prefix||'',suffix:data.suffix||'',start:Number.isSafeInteger(data.start)&&data.start>=0?data.start:0,text:text(),sourceRevision:current.sourceRevision,createdAt:new Date().toISOString()});
  } else if(data.action==='edit') {
    if(index<0)fail('Комментарий не найден',404);state.annotations[index]={...state.annotations[index],text:text(),updatedAt:new Date().toISOString()};
  } else if(data.action==='delete') {
    if(index<0)fail('Комментарий не найден',404);state.deletedAnnotations.push(state.annotations.splice(index,1)[0]);state.deletedAnnotations=state.deletedAnnotations.slice(-100);
  } else if(data.action==='restore') {
    const removed=state.deletedAnnotations.findIndex(c=>c.id===data.id);if(removed<0)fail('Удалённый комментарий не найден',404);
    state.annotations.push(state.deletedAnnotations.splice(removed,1)[0]);state.annotations.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  } else fail('Неизвестное действие');
  store.versions.saveState(relative,state);return annotations(store,relative);
}
export function exportAnnotations(store,relative) {
  const document=store.read(relative),discussion=annotations(store,relative);
  const text=`Документ: ${path.join(store.root,relative)}\nВерсия: ${document.revision}\n\nИсходный Markdown:\n${document.content}\n\nКомментарии владельца (${discussion.comments.length}):\n`+discussion.comments.map((c,i)=>`\n${i+1}. Цитата: ${c.quote}\nКомментарий: ${c.text}\nID: ${c.id}\nВерсия цитаты: ${c.sourceRevision}\n`).join('');
  return {document,discussion,text};
}
export function folder(store,relative) {
  const directory=store.resolveDirectory(relative),entries=[];let mutable=Boolean(relative);
  if(!relative)return {path:'',revision:hash([]),mutable:false,documents:[]};
  const walk=(dir,trail)=>{for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const name=trail?trail+'/'+item.name:item.name,file=path.join(dir,item.name);
    if(item.isSymbolicLink()||item.name.startsWith('.')||['node_modules','output','vendor','dist','build'].includes(item.name)){mutable=false;entries.push([name,'protected']);continue;}
    if(item.isDirectory()){entries.push([name,'directory']);walk(file,name);}
    else if(item.isFile()){const safe=/\.(md|html)$/.test(item.name)&&!protectedFile((relative?relative+'/':'')+name);if(!safe)mutable=false;entries.push([name,'file',safe?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):String(fs.statSync(file).mtimeMs)]);}
    else {mutable=false;entries.push([name,'protected']);}
  }};walk(directory,'');
  return {path:relative,revision:hash(entries),mutable,documents:entries.filter(e=>e[1]==='file'&&/\.(md|html)$/.test(e[0])).map(e=>(relative?relative+'/':'')+e[0])};
}
export function listFolders(store) {
  // Document parents and explicitly created folders; no traversal of dependency/code trees.
  const names=new Set(['']);for(const doc of store.list()){const parts=doc.path.split('/');parts.pop();for(let i=1;i<=parts.length;i++)names.add(parts.slice(0,i).join('/'));}
  const state=store.versions.state('__folders__');for(const name of state.folders||[]){try{store.resolveDirectory(name);names.add(name);}catch{}}
  return [...names].sort().map(name=>({path:name}));
}
export function rememberFolder(store,name) {const state=store.versions.state('__folders__');const parts=name.split('/'),parents=parts.map((_,i)=>parts.slice(0,i+1).join('/'));state.folders=[...new Set([...(state.folders||[]),...parents])];store.versions.saveState('__folders__',state);}
export function actFolder(store,data) {
  const relative=data.path;
  if(data.action==='create') {
    if(!relative)fail('Укажите папку');store.validateDirectory(relative);const parent=store.resolveDirectory(path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative)),target=path.join(parent,path.posix.basename(relative));
    if(present(target))fail('Папка или файл уже существует',409);fs.mkdirSync(target,{mode:0o700});rememberFolder(store,relative);return folder(store,relative);
  }
  if(data.action==='restore') {
    if(typeof data.id!=='string'||! /^[a-f0-9-]{36}$/.test(data.id))fail('Некорректная запись удаления');
    const dir=path.join(store.root,'.trash',data.id);if(!present(path.join(dir,'folder')))fail('Удалённая папка не найдена',404);
    const record=JSON.parse(fs.readFileSync(path.join(dir,'record.json'),'utf8'));store.validateDirectory(record.path);
    const parent=store.resolveDirectory(path.posix.dirname(record.path)==='.'?'':path.posix.dirname(record.path)),target=path.join(parent,path.posix.basename(record.path));if(present(target))fail('Папка уже существует',409);
    fs.renameSync(path.join(dir,'folder'),target);for(const doc of record.documents)store.versions.move('deleted/'+data.id+'/'+doc,doc);
    store.catalogue=null;rememberFolder(store,record.path);return folder(store,record.path);
  }
  const current=folder(store,relative);if(current.revision!==data.revision)fail('Папка изменилась. Обновите дерево.',409);
  if(!current.mutable)fail('В папке есть служебные файлы, код или ссылки. Перенос и удаление запрещены.',403);
  if(data.action==='move') {
    const destination=data.destination;store.validateDirectory(destination);if(!destination||destination===relative||destination.startsWith(relative+'/'))fail('Нельзя переместить папку в себя');
    const parent=store.resolveDirectory(path.posix.dirname(destination)==='.'?'':path.posix.dirname(destination)),target=path.join(parent,path.posix.basename(destination));if(present(target))fail('Папка или файл уже существует',409);
    rememberFolder(store,path.posix.dirname(relative)==='.'?'':path.posix.dirname(relative));fs.renameSync(store.resolveDirectory(relative),target);
    for(const doc of current.documents){const next=destination+doc.slice(relative.length);store.versions.move(doc,next);if(doc.endsWith('.md')){const file=store.resolve(next),before=fs.readFileSync(file,'utf8'),after=rebaseManagedImages(before,doc,next);if(after!==before)fs.writeFileSync(file,after);}}
    const state=store.versions.state('__folders__');state.folders=(state.folders||[]).map(p=>p===relative||p.startsWith(relative+'/')?destination+p.slice(relative.length):p);store.versions.saveState('__folders__',state);
    store.catalogue=null;rememberFolder(store,destination);return folder(store,destination);
  }
  if(data.action==='delete') {
    const id=randomUUID(),dir=path.join(store.root,'.trash',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'record.json'),JSON.stringify({path:relative,documents:current.documents,deletedAt:new Date().toISOString()}),{mode:0o600});
    fs.renameSync(store.resolveDirectory(relative),path.join(dir,'folder'));for(const doc of current.documents)store.versions.move(doc,'deleted/'+id+'/'+doc);store.catalogue=null;return {id,path:relative,kind:'folder'};
  }
  fail('Неизвестное действие');
}
