import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export const continuousNotePath='letushv/continuous-note.md';
const notePattern=/<!-- horizon-note:([a-f0-9-]{36}) ([^\s]+) -->\n([\s\S]*?)\n<!-- \/horizon-note -->\n?/g;
export function readNotes(workspace){
 let doc;try{doc=workspace.read(continuousNotePath);}catch(e){if(e.status!==404)throw e;}
 const content=doc?.content||'',entries=[...content.matchAll(notePattern)].map(m=>({id:m[1],createdAt:m[2],text:m[3]}));
 return {path:continuousNotePath,revision:doc?.revision||null,entries,legacy:content.replace(notePattern,'').replace(/^# Заметки\s*/,'').trim()};
}
export function actNotes(workspace,input){
 if(!['add','edit'].includes(input.action)||!/^[a-f0-9-]{36}$/i.test(input.id||''))fail('Некорректная запись');
 if(typeof input.text!=='string'||!input.text.trim()||input.text.length>100000||input.text.includes('<!-- horizon-note:')||input.text.includes('<!-- /horizon-note -->')||input.text.includes('\0'))fail('Напишите мысль (до 100 000 знаков)');
 const current=readNotes(workspace),old=current.entries.find(e=>e.id===input.id);
 if(input.action==='add'&&old){if(old.text!==input.text)fail('Эта запись уже сохранена с другим текстом',409);return current;}
 if(input.revision!==current.revision)fail('Заметка изменилась. Твой ввод сохранён; обнови страницу и повтори.',409);
 let content=current.revision?workspace.read(continuousNotePath).content:'# Заметки\n\n';
 if(input.action==='add'){
  const entry='<!-- horizon-note:'+input.id+' '+new Date().toISOString()+' -->\n'+input.text+'\n<!-- /horizon-note -->\n\n';
  const start=content.search(notePattern);if(start>=0)content=content.slice(0,start)+entry+content.slice(start);else content+=entry;
 }else{
  if(!old)fail('Запись не найдена',404);
  content=content.replace(notePattern,(match,id,date)=>id===input.id?'<!-- horizon-note:'+id+' '+date+' -->\n'+input.text+'\n<!-- /horizon-note -->\n':match);
 }
 if(current.revision)workspace.save(continuousNotePath,current.revision,content);else workspace.create(continuousNotePath,content);
 return readNotes(workspace);
}

export function uploadImage(workspace,input){
 const target=workspace.target(input.path);let doc;try{doc=workspace.read(input.path);}catch(e){if(e.status!==404||input.path!==continuousNotePath)throw e;}if(doc?.format==='html')fail('HTML открыт для чтения');
 if(typeof input.data!=='string'||!input.data.length||input.data.length>14000000||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))fail('Некорректное изображение');
 const bytes=Buffer.from(input.data,'base64');if(bytes.toString('base64')!==input.data)fail('Некорректное изображение');
 if(bytes.length>10000000)fail('Изображение больше 10 МБ',413);
 const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpg':/^GIF8[79]a/.test(bytes.subarray(0,6).toString())?'gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':null;
 if(!ext)fail('Поддерживаются PNG, JPEG, GIF и WebP');
 let directory=target.store.root;
 for(const name of ['assets','horizon-images']){directory=path.join(directory,name);if(!fs.existsSync(directory))fs.mkdirSync(directory);if(fs.lstatSync(directory).isSymbolicLink()||!fs.statSync(directory).isDirectory())fail('Недоступная папка изображений',403);}
 const filename=createHash('sha256').update(bytes).digest('hex')+'.'+ext,file=path.join(directory,filename);
 if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())fail('Недоступное изображение',403);}else fs.writeFileSync(file,bytes,{flag:'wx'});
 const relative='assets/horizon-images/'+filename,prefix=target.project?'projects/'+target.project.id+'/':'';
 const label=String(input.name||'Изображение').replace(/\.[^.]+$/,'').replace(/[\[\]\\\r\n]/g,' ').slice(0,150)||'Изображение';
 return {path:prefix+relative,url:'/document-preview/'+prefix+relative,markdown:'!['+label+'](<'+path.posix.relative(path.posix.dirname(target.relative),relative)+'>)'};
}

// Only our managed images change on a file move. Other Markdown bytes stay intact.
export function rebaseManagedImages(content,from,to){
 return content.replace(/(!\[[^\]]*\]\()(<([^>]+)>|([^\s)]+))(?=[\s)])/g,(match,open,raw,angle,plain)=>{
  let source;try{source=decodeURIComponent(angle||plain);}catch{return match;}
  const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(from),source));
  if(!resolved.startsWith('assets/horizon-images/'))return match;
  const next=path.posix.relative(path.posix.dirname(to),resolved);return open+(angle?'<'+next+'>':next);
 });
}

export function sessions(workspace,input){
 const file=path.join(workspace.root,'.horizon/session-inventory.json');
 if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())fail('Недоступный список сессий',403);
 let saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
 if(!Array.isArray(saved))fail('Список сессий повреждён',500);
 if(input){
  if(!workspace.roots().some(p=>p.id===input.projectId)||!['codex','claude','zai','other'].includes(input.provider)||typeof input.sessionId!=='string'||!input.sessionId.trim()||input.sessionId.length>500)fail('Укажите проект, провайдера и сессию');
  const value={projectId:input.projectId,provider:input.provider,sessionId:input.sessionId.trim(),title:String(input.title||input.sessionId).slice(0,500)};
  const index=saved.findIndex(s=>s.projectId===value.projectId&&s.provider===value.provider&&s.sessionId===value.sessionId);if(index>=0)saved[index]=value;else saved.push(value);
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(saved),{flag:'wx',mode:0o600});fs.renameSync(temp,file);
 }
 const data=workspace.review.read(),map=new Map();
 const add=(s,row)=>{const key=JSON.stringify([s.projectId,s.provider,s.sessionId]);let entry=map.get(key);if(!entry){entry={...s,title:s.title||row?.taskTitle||s.sessionId,taskIds:[]};map.set(key,entry);}if(row&&!entry.taskIds.includes(row.id))entry.taskIds.push(row.id);};
 for(const item of saved)add(item);
 for(const row of data.rows){for(const s of row.overviewSessions||[])add({...s,projectId:row.projectId},row);if(row.assignee?.sessionId)add({...row.assignee,projectId:row.projectId},row);}
 return {sessions:[...map.values()],projects:data.projects};
}
