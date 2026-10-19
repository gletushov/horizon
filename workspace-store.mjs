import fs from 'node:fs';
import {annotations,annotate,exportAnnotations,folder,listFolders,actFolder} from './document-workspace.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {ReviewWorkspace,reviewPath,reviewMeta} from './review-workspace.mjs';

const agentOverviewPath='reviews/agent-overview.md';
const agentInboxPath='.horizon/inbox.json';
const agentProviders=new Set(['codex','claude','zai','other']);
const agentInboxStatus=/^\s*\*\*\s*(needs review|blocked|done)\s*\.?\s*\*\*/i;
const agentFail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const agentCopy=value=>JSON.parse(JSON.stringify(value));
const agentSleep=ms=>{const shared=new SharedArrayBuffer(4);Atomics.wait(new Int32Array(shared),0,0,ms);};
const agentProjectKey=projectId=>projectId===null?'horizon':projectId;
const agentBindingKey=(projectId,provider,sessionId)=>JSON.stringify([agentProjectKey(projectId),provider,sessionId]);
const agentStatus={working:'In progress',review:'Needs review',closed:'Closed'};

function agentOwnedContent(row) {
  if(row?.agentContent && typeof row.agentContent==='object'&&!Array.isArray(row.agentContent)) {
    return {task:String(row.agentContent.task??''),summary:String(row.agentContent.summary??''),updates:String(row.agentContent.updates??'')};
  }
  return String(row?.agentContent??row?.agent??row?.updates??'');
}

function agentInboxVersion(row) {
  return createHash('sha256').update(JSON.stringify(agentOwnedContent(row))).digest('hex');
}

function agentInboxEligible(row) {
  return row?.status!=='closed'&&typeof row?.updates==='string'&&agentInboxStatus.test(row.updates);
}

function agentString(value,name,max,{required=false}={}) {
  if(typeof value!=='string'||(required&&!value.trim())||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))agentFail(`Некорректное поле ${name}`);
  return value.trim();
}

function agentRegistryRead(file) {
  if(!fs.existsSync(file))return {version:1,bindings:[],tasks:{}};
  if(fs.lstatSync(file).isSymbolicLink())agentFail('Недоступный реестр сессий',403);
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{agentFail('Реестр сессий повреждён',500);}
  if(!value||value.version!==1||!Array.isArray(value.bindings))agentFail('Реестр сессий повреждён',500);
  if(!Object.hasOwn(value,'tasks'))value.tasks={};
  if(!value.tasks||typeof value.tasks!=='object'||Array.isArray(value.tasks))agentFail('Реестр сессий повреждён',500);
  for(const [taskId,projectId] of Object.entries(value.tasks)){
    if(!/^T\d{2,}$/.test(taskId)||!(projectId===null||(typeof projectId==='string'&&/^[a-z0-9-]+$/.test(projectId))))agentFail('Реестр сессий повреждён',500);
  }
  for(const binding of value.bindings){
    if(!binding||typeof binding!=='object'||!Object.hasOwn(binding,'projectId')||!(binding.projectId===null||(typeof binding.projectId==='string'&&/^[a-z0-9-]+$/.test(binding.projectId)))||typeof binding.provider!=='string'||!agentProviders.has(binding.provider)||typeof binding.sessionId!=='string'||!binding.sessionId||!/^T\d{2,}$/.test(binding.taskId||''))agentFail('Реестр сессий повреждён',500);
    if(Object.hasOwn(value.tasks,binding.taskId)&&value.tasks[binding.taskId]!==binding.projectId)agentFail('Реестр сессий повреждён',500);
    value.tasks[binding.taskId]=binding.projectId;
  }
  return value;
}

function agentRegistryWrite(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

function withAgentRegistryLock(root,fn) {
  const directory=path.join(root,'.horizon');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'agent-sessions.lock');let descriptor;
  for(let attempt=0;attempt<100;attempt++){
    try{descriptor=fs.openSync(file,'wx',0o600);break;}catch(error){if(error.code!=='EEXIST')throw error;agentSleep(10);}
  }
  if(descriptor===undefined)agentFail('Реестр сессий занят. Повторите попытку.',409);
  try{return fn(path.join(directory,'agent-sessions.json'));}finally{try{fs.closeSync(descriptor);}catch{}try{fs.unlinkSync(file);}catch{}}
}

function agentInboxStateRead(root) {
  const file=path.join(root,agentInboxPath);
  if(!fs.existsSync(file))return {version:1,readversions:{}};
  if(fs.lstatSync(file).isSymbolicLink())agentFail('Недоступное состояние Inbox',403);
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{agentFail('Состояние Inbox повреждено',500);}
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.hasOwn(value,'version')&&value.version!==1))agentFail('Состояние Inbox повреждено',500);
  const readversions=value.readversions??{};
  if(!readversions||typeof readversions!=='object'||Array.isArray(readversions))agentFail('Состояние Inbox повреждено',500);
  for(const [id,version] of Object.entries(readversions)){
    if(!/^[RT]\d{2,}$/.test(id)||typeof version!=='string'||!/^[a-f0-9]{64}$/i.test(version))agentFail('Состояние Inbox повреждено',500);
  }
  return {...value,version:1,readversions};
}

function agentInboxStateWrite(root,state) {
  const directory=path.join(root,'.horizon');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(root,agentInboxPath);
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())agentFail('Недоступное состояние Inbox',403);
  const temp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

function withAgentInboxLock(root,fn) {
  const directory=path.join(root,'.horizon');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'inbox.lock');let descriptor;
  for(let attempt=0;attempt<100;attempt++){
    try{descriptor=fs.openSync(file,'wx',0o600);break;}catch(error){if(error.code!=='EEXIST')throw error;agentSleep(10);}
  }
  if(descriptor===undefined)agentFail('Inbox занят. Повторите попытку.',409);
  try{return fn();}finally{try{fs.closeSync(descriptor);}catch{}try{fs.unlinkSync(file);}catch{}}
}

// Explicit local connections. Files stay at their original paths.
export class WorkspaceStore {
  constructor(root) {
    this.root=path.resolve(root);
    this.toolsRoot=path.dirname(fileURLToPath(import.meta.url));
    this.local=new Store(this.root);
    this.projects=[];
    this.review=new ReviewWorkspace(this);
    const configPath=path.join(this.root,'horizon.config.json');
    if(fs.existsSync(configPath)) {
      const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
      for(const project of config.projects || []) {
        if(!/^[a-z0-9-]+$/.test(project.id) || !path.isAbsolute(project.path)) throw new Error('Invalid project connection');
        if(this.projects.some(p=>p.id===project.id))throw new Error('Duplicate project connection');
        this.projects.push({...project,store:new Store(project.path)});
      }
    }
  }
  connect(name,directory) {
    if(typeof name!=='string'||!name.trim()||name.length>100||typeof directory!=='string'||!path.isAbsolute(directory))throw Object.assign(new Error('Укажите название и абсолютный путь к папке'),{status:400});
    let canonical;try{canonical=fs.realpathSync(directory);if(!fs.statSync(canonical).isDirectory())throw new Error();}catch{throw Object.assign(new Error('Папка не найдена'),{status:404});}
    if(canonical===path.parse(canonical).root)throw Object.assign(new Error('Выберите папку проекта'),{status:400});
    if(canonical===this.root||this.projects.some(p=>p.path===canonical))throw Object.assign(new Error('Эта папка уже подключена'),{status:409});
    const configPath=path.join(this.root,'horizon.config.json');const raw=fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8'):'{}';const config=JSON.parse(raw);config.projects||=[];
    if(config.projects.some(p=>p.path===canonical))throw Object.assign(new Error('Эта папка уже подключена. Обновите Horizon.'),{status:409});
    const project={id:'project-'+randomUUID().slice(0,8),name:name.trim(),path:canonical};config.projects.push(project);
    const temp=configPath+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
    if(fs.existsSync(configPath)&&fs.readFileSync(configPath,'utf8')!==raw){fs.unlinkSync(temp);throw Object.assign(new Error('Настройки изменились. Повторите подключение.'),{status:409});}
    fs.renameSync(temp,configPath);this.projects.push({...project,store:new Store(canonical)});return project;
  }
  target(relative) {
    if(typeof relative==='string' && relative.startsWith('projects/')) {
      const [,id,...parts]=relative.split('/');
      const project=this.projects.find(p=>p.id===id);
      if(!project)throw Object.assign(new Error('Проект не подключён'),{status:404});
      return {store:project.store,relative:parts.join('/'),project};
    }
    return {store:this.local,relative,project:null};
  }
  decorate(doc,project) {
    const decorated={...doc,path:project?`projects/${project.id}/${doc.path}`:doc.path,sourcePath:path.join(project?.path || this.root,doc.path),projectId:project?.id || null,projectName:project?.name || 'Horizon',editable:doc.editable!==false};
    if(!project&&doc.path===agentOverviewPath&&typeof doc.content==='string')return this.decorateAgentOverview(decorated);
    return decorated;
  }
  decorateAgentOverview(doc) {
    const registry=agentRegistryRead(path.join(this.root,'.horizon','agent-sessions.json'));
    const metadata=reviewMeta(doc.content);
    return {...doc,rows:Array.isArray(doc.rows)?doc.rows.map(row=>{
      const own=metadata.rows[row.id]||{},parent=metadata.rows[own.parentId]||{};
      const owner=own.parentId||row.id,ownerMeta=metadata.rows[owner]||{};
      const registered=Object.hasOwn(ownerMeta,'projectId')||Object.hasOwn(registry.tasks,owner);
      const overviewProjectId=Object.hasOwn(ownerMeta,'projectId')?ownerMeta.projectId:registered?registry.tasks[owner]:null;
      const project=overviewProjectId===null?null:this.projects.find(candidate=>candidate.id===overviewProjectId);
      const overviewProjectName=!registered?'Unassigned':overviewProjectId===null?'Horizon':project?.name||'Unassigned';
      const overviewSessions=registry.bindings.filter(binding=>binding.taskId===row.id).map(binding=>({provider:binding.provider,sessionId:binding.sessionId}));
      const inheritedSessions=registry.bindings.filter(binding=>binding.taskId===owner).map(({provider,sessionId})=>({provider,sessionId}));
      let currentAssignee=Object.hasOwn(own,'assignee')?own.assignee:Object.hasOwn(parent,'assignee')?parent.assignee:inheritedSessions.length===1?inheritedSessions[0]:null;
      const report=(doc.rows.find(candidate=>candidate.id===owner)||row).updates;
      const reported=report.match(/\bsource:\s*(zcode|z\.ai|claude|codex)\b/i)?.[1]?.toLowerCase();
      const provider=reported==='zcode'||reported==='z.ai'?'zai':reported;
      const assigneeConflict=Boolean(provider&&currentAssignee&&provider!==currentAssignee.provider&&!Object.hasOwn(own,'assignee')&&!Object.hasOwn(parent,'assignee'));
      if(assigneeConflict)currentAssignee=null;
      const commentVersion=createHash('sha256').update(JSON.stringify(row.comment)).digest('hex');
      return {...row,overviewProjectId,overviewProjectName,overviewSessions,parentId:own.parentId||null,currentAssignee,assigneeConflict,commentVersion};
    }):doc.rows};
  }
  list() {
    return [...this.local.list().map(doc=>this.decorate(doc,null)),...this.projects.flatMap(project=>project.store.list().map(doc=>this.decorate(doc,project)))];
  }
  read(relative) {
    const target=this.target(relative);
    return this.decorate(target.store.read(target.relative),target.project);
  }
  save(relative,revision,content) {
    const target=this.target(relative);
    return this.decorate(target.store.save(target.relative,revision,content),target.project);
  }
  roots() {return [{id:null,name:'Horizon',prefix:'',path:this.root},...this.projects.map(p=>({id:p.id,name:p.name,prefix:`projects/${p.id}/`,path:p.path}))];}
  annotations(relative,data) {const t=this.target(relative);return {...(data?annotate(t.store,t.relative,data):annotations(t.store,t.relative)),path:relative};}
  exportAnnotations(relative) {const t=this.target(relative),result=exportAnnotations(t.store,t.relative);return {...result,document:this.decorate(result.document,t.project)};}
  folders() {return this.roots().flatMap(p=>listFolders(p.id?this.projects.find(item=>item.id===p.id).store:this.local).map(f=>({path:p.prefix+f.path,projectId:p.id})));}
  folder(relative,data) {
    const t=this.target(relative);
    if(data?.destination!==undefined&&this.target(data.destination).store!==t.store)throw Object.assign(new Error('Перемещение доступно внутри проекта'),{status:400});
    const result=data?actFolder(t.store,{...data,path:t.relative,...(data.destination!==undefined?{destination:this.target(data.destination).relative}:{})}):folder(t.store,t.relative);
    return {...result,path:t.project?'projects/'+t.project.id+'/'+result.path:result.path,projectId:t.project?.id||null};
  }
  create(relative,content) {const t=this.target(relative);return this.decorate(t.store.create(t.relative,content),t.project);}
  importDocuments(destination,files) {const t=this.target(destination);return t.store.importDocuments(t.relative,files).map(doc=>this.decorate(doc,t.project));}
  registerAgentSession(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))agentFail('Ожидается объект регистрации агента');
    const projectId=input.projectId===undefined||input.projectId===null?null:agentString(input.projectId,'projectId',100,{required:true});
    const project=projectId===null?null:this.projects.find(candidate=>candidate.id===projectId);
    if(projectId!==null&&!project)agentFail('Проект не подключён',404);
    const title=agentString(input.taskTitle,'taskTitle',1000,{required:true});
    const summary=input.summary===undefined||input.summary===null?'':agentString(input.summary,'summary',100000);
    const provider=agentString(input.provider,'provider',20,{required:true});
    if(!agentProviders.has(provider))agentFail('Неизвестный провайдер агента');
    const sessionId=input.sessionId===undefined||input.sessionId===null?null:agentString(input.sessionId,'sessionId',500,{required:true});
    const taskId=input.taskId===undefined||input.taskId===null?null:agentString(input.taskId,'taskId',20,{required:true});
    if(taskId&&!/^T\d{2,}$/.test(taskId))agentFail('Некорректный ID задачи');
    return withAgentRegistryLock(this.root,registryFile=>{
      const registry=agentRegistryRead(registryFile);
      const key=sessionId===null?null:agentBindingKey(projectId,provider,sessionId);
      const binding=key===null||input.mode==='create'?null:registry.bindings.find(candidate=>agentBindingKey(candidate.projectId,candidate.provider,candidate.sessionId)===key&&(!taskId||candidate.taskId===taskId));
      const doc=this.local.read(agentOverviewPath);
      if(doc.reviewSchema?.kind!=='task-summary')agentFail('Сводка агентов должна использовать схему task-summary v2',409);
      const rowFor=id=>doc.rows.find(row=>row.id===id);
      const taskHasOwner=id=>Object.hasOwn(registry.tasks,id);
      const assertTaskOwner=id=>{
        if(taskHasOwner(id)&&registry.tasks[id]!==projectId)agentFail('Задача принадлежит другому проекту',409);
        if(registry.bindings.some(candidate=>candidate.taskId===id&&candidate.projectId!==projectId))agentFail('Задача уже связана с другим проектом',409);
      };
      const ensureTaskOwner=(target,id)=>{if(!Object.hasOwn(target.tasks,id))target.tasks[id]=projectId;};
      if(binding){
        if(taskId&&taskId!==binding.taskId)agentFail('Сессия уже привязана к другой задаче',409);
        assertTaskOwner(binding.taskId);
        const row=rowFor(binding.taskId);if(!row)agentFail('Реестр указывает на отсутствующую задачу',409);
        return this.agentSessionResult(doc,row,projectId,provider,sessionId);
      }
      let row=taskId?rowFor(taskId):null;
      if(taskId&&!row)agentFail('Задача не найдена: '+taskId,404);
      if(row)assertTaskOwner(row.id);
      if(row){
        if(sessionId===null){
          if(!taskHasOwner(row.id)){const next=agentCopy(registry);ensureTaskOwner(next,row.id);agentRegistryWrite(registryFile,next);}
          return this.agentSessionResult(doc,row,projectId,provider,null);
        }
        const alreadyListed=row.task?.includes(sessionId);
        const updates=alreadyListed?row.updates:[row.updates,`Source binding added: ${provider}. Updated: ${new Date().toISOString()}.`].filter(Boolean).join('\n');
        const saved=alreadyListed?doc:this.local.agentReview(agentOverviewPath,doc.revision,[{id:row.id,updates}]);
        const next=agentCopy(registry);ensureTaskOwner(next,row.id);next.bindings.push({projectId,provider,sessionId,taskId:row.id});agentRegistryWrite(registryFile,next);
        return this.agentSessionResult(saved,saved.rows.find(candidate=>candidate.id===row.id),projectId,provider,sessionId);
      }
      const projectName=project?.name || 'Horizon';
      const task=`${projectName} · ${title} — ${provider}${sessionId?` ${sessionId}`:''}`;
      const now=new Date().toISOString();
      const updates=`**In progress.** Updated: ${now}. **Next action:** Передать задачу агенту.`;
      const saved=this.local.agentReview(agentOverviewPath,doc.revision,[{task,summary:summary||'—',updates}]);
      row=saved.rows.at(-1);
      const next=agentCopy(registry);ensureTaskOwner(next,row.id);if(sessionId!==null)next.bindings.push({projectId,provider,sessionId,taskId:row.id});agentRegistryWrite(registryFile,next);
      return this.agentSessionResult(saved,row,projectId,provider,sessionId);
    });
  }
  agentSessionResult(doc,row,projectId,provider,sessionId) {
    if(!row)agentFail('Задача не найдена',404);
    const status=agentStatus[row.status]||'In progress';
    const instruction=`Task ${row.id}: ${row.taskTitle || row.task}. Purpose: ${row.summary || "Not specified"}. Current status: ${status}. Read ${path.join(this.root,agentOverviewPath)} and ${path.join(this.toolsRoot,'skills/table-review/SKILL.md')}. After each significant result and before completion, update ${row.id} with a fresh revision using ${path.join(this.toolsRoot,'scripts/review-agent.mjs')} (workspace root: ${this.root}); keep the user comments column unchanged and lead updates with an English status.`;
    return {ok:true,projectId,taskId:row.id,docPath:agentOverviewPath,revision:doc.revision,status,provider,sessionId,instruction};
  }
  agentInbox(includeRead=false) {
    const overviewFile=path.join(this.root,agentOverviewPath);
    if(!fs.existsSync(overviewFile))return {items:[],count:0};
    const doc=this.read(agentOverviewPath);
    const state=agentInboxStateRead(this.root);
    const meta=reviewMeta(doc.content);
    const items=[];
    for(const row of doc.rows){
      const eligible=agentInboxEligible(row);
      if(!eligible&&!includeRead)continue;
      const version=agentInboxVersion(row);
      const m=meta.rows[row.id]||{},resultVersion=createHash('sha256').update(JSON.stringify([row.task,row.summary,row.updates])).digest('hex');
      const unread=eligible&&state.readversions[row.id]!==version&&m.seen!==resultVersion&&m.accepted!==resultVersion&&!m.deferred;
      if(!unread&&!includeRead)continue;
      items.push({unread,comment:row.comment,commentState:row.commentInProgress?'In progress':row.commentAcknowledged?'Reviewed':null,id:row.id,projectId:row.overviewProjectId,projectName:row.overviewProjectName,taskTitle:row.taskTitle,updates:row.updates,version,path:agentOverviewPath});
    }
    return {items,count:items.filter(item=>item.unread).length};
  }
  markAgentInboxRead(id,version) {
    if(typeof id!=='string'||!/^[RT]\d{2,}$/.test(id))agentFail('Некорректный ID результата');
    if(typeof version!=='string'||!/^[a-f0-9]{64}$/i.test(version))agentFail('Некорректная версия результата');
    const requestedVersion=version.toLowerCase();
    return withAgentInboxLock(this.root,()=>{
      const overviewFile=path.join(this.root,agentOverviewPath);
      if(!fs.existsSync(overviewFile))agentFail('Результат не найден',404);
      const doc=this.read(agentOverviewPath);const row=doc.rows.find(candidate=>candidate.id===id);
      if(!row)agentFail('Результат не найден',404);
      const currentVersion=agentInboxVersion(row);
      if(currentVersion!==requestedVersion)agentFail('Результат устарел. Обновите Inbox.',409);
      if(!agentInboxEligible(row))agentFail('Результат не найден',404);
      const state=agentInboxStateRead(this.root);state.readversions[id]=currentVersion;agentInboxStateWrite(this.root,state);
      return {ok:true,id,version:currentVersion};
    });
  }
  remove(relative,revision) {const t=this.target(relative);return {...t.store.remove(t.relative,revision),projectId:t.project?.id || null};}
  restore(id,projectId) {const p=projectId?this.projects.find(p=>p.id===projectId):null;if(projectId&&!p)throw new Error('Проект не найден');return this.decorate((p?.store || this.local).restore(id),p);}
  rename(relative,revision,destination) {const t=this.target(relative),d=this.target(destination);if(t.store!==d.store)throw Object.assign(new Error('Перемещение доступно внутри проекта'),{status:400});return this.decorate(t.store.rename(t.relative,revision,d.relative),t.project);}
  addRow(relative,revision,theme,comment) {const t=this.target(relative);return this.decorate(t.store.addRow(t.relative,revision,theme,comment),t.project);}
  moveTask(data) {return this.local.moveTask(data.path,data.revision,data.index,data.destination,data.targetRevision,data.before,data.id,data.beforeId);}
  deleteTask(relative,revision,index) {if(relative&&typeof relative==='object'){({path:relative,revision,index}=relative);}const t=this.target(relative);return this.decorate(t.store.deleteTask(t.relative,revision,index),t.project);}
  removeTask(...args) {return this.deleteTask(...args);}
  agentReview(relative,revision,changes){if(relative===reviewPath)return this.review.agentReview(revision,changes);const t=this.target(relative);return this.decorate(t.store.agentReview(t.relative,revision,changes),t.project);}
  history(relative){const t=this.target(relative);return t.store.history(t.relative);}
  version(relative,id){const t=this.target(relative);return t.store.version(t.relative,id);}
  rowState(relative,revision,id,action){const t=this.target(relative);return this.decorate(t.store.rowState(t.relative,revision,id,action),t.project);}
  restoreVersion(relative,revision,id,scope,rowId){const t=this.target(relative);return this.decorate(t.store.restoreVersion(t.relative,revision,id,scope,rowId),t.project);}
  comment(relative,revision,edits) {
    const target=this.target(relative);
    return this.decorate(target.store.comment(target.relative,revision,edits),target.project);
  }
}
