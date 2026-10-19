import {createHash} from 'node:crypto';
import path from 'node:path';
import {parseReview,encode,setLineCells,appendRows} from './store.mjs';
export const reviewPath='reviews/agent-overview.md';
const marker=/^<!-- horizon-review-v1: (.+) -->\r?$/m;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const providers=new Set(['codex','claude','zai','other']);
export function reviewMeta(content){
 const match=content.match(marker);if(!match)return {rows:{}};
 let data;try{data=JSON.parse(match[1]);}catch{fail('Метаданные таблицы повреждены',409);}
 if(!data||typeof data.rows!=='object'||Array.isArray(data.rows)||!data.rows)fail('Метаданные таблицы повреждены',409);
 for(const [id,value] of Object.entries(data.rows))if(!/^T\d+$/.test(id)||!value||typeof value!=='object'||Array.isArray(value))fail('Метаданные строки повреждены',409);
 return data;
}
function withMeta(content,meta){const line='<!-- horizon-review-v1: '+JSON.stringify(meta).replace(/</g,'\\u003c').replace(/>/g,'\\u003e')+' -->';return marker.test(content)?content.replace(marker,()=>line):content.replace(/\s*$/,'')+'\n\n'+line+'\n';}
function text(value,label,max=50000){if(typeof value!=='string'||value.length>max||value.includes('\0'))fail('Некорректное поле: '+label);return value;}
function assignment(value){if(value===null)return null;if(!value||!providers.has(value.provider)||typeof value.sessionId!=='string'||value.sessionId.length>500)fail('Укажите провайдера и сессию');const sessionId=value.sessionId.trim();if(value.provider==='codex'&&sessionId&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sessionId))fail('Некорректный ID сессии Codex');return {provider:value.provider,sessionId};}
export class ReviewWorkspace {
 constructor(workspace){this.workspace=workspace;this.store=workspace.local;}
 read(){
  const doc=this.workspace.read(reviewPath),meta=reviewMeta(doc.content);
  const inbox=this.workspace.agentInbox(true);const unread=new Map(inbox.items.map(r=>[r.id,r]));
  const rows=doc.rows.map(row=>{
   const m=meta.rows[row.id]||{},parentId=m.parentId||null;
   const hasProject=Object.hasOwn(m,'projectId')||row.overviewProjectName!=='Unassigned';
   const projectId=Object.hasOwn(m,'projectId')?m.projectId:row.overviewProjectId;
   const resultVersion=hash([row.task,row.summary,row.updates]),commentVersion=hash(row.comment);
   const commentAddressed=Boolean(row.comment&&!/^\*\*In progress\./i.test(row.updates)&&(m.replyTo?m.replyTo===commentVersion:row.commentAcknowledged));
   let state=m.accepted===resultVersion?'accepted':m.deferred?'deferred':row.status==='closed'&&!m.accepted&&!m.reopened?'accepted':/^\*\*Blocked[. ]/i.test(row.updates)?'blocked':/^\*\*(Needs review|Done|Verified)[. ]/i.test(row.updates)?'review':/^\*\*In progress[. ]/i.test(row.updates)?'working':'draft';
   if(state==='accepted'&&m.acceptedComment&&m.acceptedComment!==commentVersion)state='review';
   const stamp=m.updatedAt||row.updates.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})/)?.[0]||m.createdAt||null;
   return {...row,updatedAt:stamp,parentId,projectId,projectAssigned:hasProject,projectName:hasProject?(this.workspace.roots().find(p=>p.id===projectId)?.name||'Проект недоступен'):'Без проекта',resultVersion,commentVersion,commentAddressed,state,unread:Boolean(unread.get(row.id)?.unread)&&m.seen!==resultVersion&&state!=='accepted',assignee:null,explicitAssignee:Object.hasOwn(m,'assignee'),delivery:m.delivery?.commentVersion===commentVersion?m.delivery:null};
  });
  const byId=new Map(rows.map(row=>[row.id,row]));
  for(const row of rows){const m=meta.rows[row.id]||{},parent=byId.get(row.parentId);if(row.parentId&&(!parent||parent.parentId))fail('Некорректная связь подзадачи '+row.id,409);
   const source=Object.hasOwn(m,'assignee')?row:Object.hasOwn(meta.rows[parent?.id]||{},'assignee')?parent:null;
   if(source)row.assignee=meta.rows[source.id].assignee;
   else {row.assignee=(parent||row).currentAssignee;row.assigneeConflict=Boolean((parent||row).assigneeConflict);}
   if(parent){row.projectId=parent.projectId;row.projectAssigned=parent.projectAssigned;row.projectName=parent.projectName;}
   if(row.delivery&&JSON.stringify(row.delivery.assignee)!==JSON.stringify(row.assignee))row.delivery=null;
  }
  for(const row of rows)if(row.state==='accepted'&&rows.some(child=>child.parentId===row.id&&!['accepted','deferred'].includes(child.state)))row.state='review';
  return {revision:doc.revision,rows,projects:this.workspace.roots(),path:reviewPath};
 }
 checked(revision){const doc=this.store.read(reviewPath);if(doc.revision!==revision)fail('Таблица изменилась. Обновите данные; ваш черновик сохранён.',409);return doc;}
 parent(rows,id,ownId=null){if(id===null||id===undefined)return null;const row=rows.find(r=>r.id===id);if(!row)fail('Родительская задача не найдена');if(row.parentId||row.id===ownId)fail('Допустимы только задача и один уровень подзадач');return row;}
 act(input){
  if(!input||typeof input!=='object')fail('Ожидается действие');
  const doc=this.checked(input.revision),current=this.read(),meta=reviewMeta(doc.content),lines=doc.content.split('\n');
  const row=current.rows.find(r=>r.id===input.id);const raw=doc.rows.find(r=>r.id===input.id);
  const action=input.action;let createdId;
  if(action==='create'){
   const title=text(input.title,'название',1000).trim();if(!title)fail('Введите название');
   const parent=this.parent(current.rows,input.parentId);
   const id='T'+String(Math.max(0,...doc.rows.map(r=>Number(r.id.slice(1))))+1).padStart(2,'0');createdId=id;
   const projectId=parent?.projectAssigned?parent.projectId:input.projectId;
   if(projectId!==undefined&&!current.projects.some(p=>p.id===projectId))fail('Проект не подключён');
   const comment=input.comment===undefined?'':text(input.comment,'поручение');
   appendRows(lines,doc,[`| ${id} · ${encode(title)} | ** | ** | ${comment?encode(comment):'**'} |`]);
   meta.rows[id]={parentId:parent?.id||null,...(projectId===undefined?{}:{projectId}),createdAt:new Date().toISOString()};
  }else{
   if(!row)fail('Пункт не найден',404);const m=meta.rows[row.id]||={};
   if(action==='comment'){
    if(input.baseComment!==row.comment)fail('Комментарий изменился. Сравните свежий текст со своим черновиком.',409);
    setLineCells(lines,raw,[[3,text(input.comment,'комментарий')||'**']]);
   }else if(action==='rename'){const title=text(input.title,'название',1000).trim();if(!title)fail('Введите название');setLineCells(lines,raw,[[0,row.id+' · '+title]]);
   }else if(action==='move'){
    const parent=this.parent(current.rows,input.parentId,row.id);
    if(parent&&current.rows.some(r=>r.parentId===row.id))fail('Сначала вынесите подзадачи: третий уровень недоступен');
    if(parent&&(!row.projectAssigned||!parent.projectAssigned||parent.projectId!==row.projectId))fail('Перенос доступен внутри одного проекта');
    if(!parent&&row.parentId){m.projectId=row.projectId;if(!Object.hasOwn(m,'assignee'))m.assignee=row.assignee;}
    m.parentId=parent?.id||null;
   }else if(action==='assign'){if(input.assignee===null&&row.parentId)delete m.assignee;else m.assignee=assignment(input.assignee);
   }else if(action==='project'){
    if(row.parentId)fail('Проект наследуется от задачи');if(!current.projects.some(p=>p.id===input.projectId))fail('Проект не подключён');
    if(row.projectAssigned&&row.projectId!==input.projectId)fail('Смена проекта существующей задачи недоступна');m.projectId=input.projectId;
   }else if(action==='accept'){
    if(input.resultVersion!==undefined&&input.resultVersion!==row.resultVersion)fail('Результат обновился. Прочитайте новую версию перед принятием.',409);
    if(!row.updates.trim())fail('Сначала нужен результат агента',409);
    if(current.rows.some(r=>r.parentId===row.id&&!['accepted','deferred'].includes(r.state)))fail('Сначала разберите или отложите подзадачи',409);
    m.accepted=row.resultVersion;m.acceptedComment=row.commentVersion;m.seen=row.resultVersion;m.deferred=false;
   }else if(action==='defer')m.deferred=true;
   else if(action==='reopen'){delete m.accepted;m.deferred=false;m.reopened=true;}
   else if(action==='seen')m.seen=row.resultVersion;
   else fail('Неизвестное действие');
  }
  const content=withMeta(lines.join('\n'),meta);this.store.write(reviewPath,doc.revision,content,'user');return {...this.read(),...(createdId?{createdId}:{})};
 }
 agentReview(revision,changes){
  const doc=this.checked(revision),current=this.read(),meta=reviewMeta(doc.content);
  if(!Array.isArray(changes)||!changes.length||changes.length>100)fail('Ожидается список изменений');
  const clean=changes.map(change=>({...change,acknowledgeComment:false}));
  const saved=this.store.agentReview(reviewPath,revision,clean,content=>{
   const parsed=parseReview(content);let next=doc.rows.length;
   for(const change of changes){
    const row=change.id?parsed.rows.find(r=>r.id===change.id):parsed.rows[next++];const m=meta.rows[row.id]||={};m.updatedAt=new Date().toISOString();
    if(Object.hasOwn(change,'parentId')){
     const parent=this.parent(current.rows,change.parentId,row.id);
     if(change.id&&current.rows.some(r=>r.parentId===row.id)&&parent)fail('Третий уровень недоступен');
     const old=current.rows.find(r=>r.id===row.id);
     if(old&&parent&&old.projectAssigned&&old.projectId!==parent.projectId)fail('Перенос доступен внутри одного проекта');
     m.parentId=parent?.id||null;if(parent?.projectAssigned)m.projectId=parent.projectId;
    }
    if(!change.id&&Object.hasOwn(change,'projectId')){if(!current.projects.some(p=>p.id===change.projectId))fail('Проект не подключён');if(m.parentId&&m.projectId!==change.projectId)fail('Проект наследуется от родителя');m.projectId=change.projectId;}
    if(change.replyTo!==undefined){if(typeof change.replyTo!=='string'||!/^[a-f0-9]{64}$/.test(change.replyTo))fail('Некорректная версия комментария');m.replyTo=change.replyTo;}
    else if(/^\*\*In progress\./i.test(change.updates||change.agent||''))m.workingFor=hash(row.comment);
    else if(change.acknowledgeComment===true&&m.workingFor)m.replyTo=m.workingFor;
   }
   return withMeta(content,meta);
  });
  return this.workspace.decorate(saved,null);
 }
 note(input){
  const value=text(input.text,'заметка');if(!value.trim())fail('Напишите мысль');
  const project=this.workspace.roots().find(p=>p.id===(input.projectId??null));if(!project)fail('Проект не подключён',404);
  let relative=project.prefix+'notes/inbox.md',doc;
  try{doc=this.workspace.read(relative);}catch(error){
   if(error.status!==404)throw error;
   try{doc=this.workspace.read(project.prefix+'letushv/inbox.md');relative=doc.path;}catch(legacyError){if(legacyError.status!==404)throw legacyError;}
  }
  const entry='\n\n## '+new Date().toISOString()+'\n\n'+value+'\n';
  const saved=doc?this.workspace.save(relative,doc.revision,doc.content+entry):this.workspace.create(relative,'# Inbox\n'+entry);
  return {path:saved.path,revision:saved.revision};
 }
 history(id){
  if(!this.read().rows.some(r=>r.id===id))fail('Пункт не найден',404);
  const entries=[];let previous;
  for(const version of this.store.history(reviewPath)){
   const row=parseReview(this.store.version(reviewPath,version.id).content).rows.find(r=>r.id===id);if(!row)continue;
   const key=hash([row.task,row.summary,row.updates,row.comment]);if(key===previous)continue;previous=key;
   entries.push({time:version.createdAt,actor:version.actor,task:row.taskTitle,updates:row.updates,comment:row.comment});
  }
  return {entries};
 }
 brief({id,revision,mode='comment',copy=false,comment}){
  this.checked(revision);const data=this.read(),row=data.rows.find(r=>r.id===id);if(!row)fail('Пункт не найден',404);
  if(!copy&&['accepted','deferred'].includes(row.state))fail('Сначала верните пункт в работу',409);
  if(!row.projectAssigned&&!copy)fail('Сначала выберите проект',409);
  if(copy&&comment!==undefined)row.comment=text(comment,'черновик поручения');
  if(!row.assignee&&!copy)fail('Выберите одного текущего исполнителя',409);
  if(!['comment','split'].includes(mode))fail('Неизвестное поручение');
  if(mode==='comment'&&!row.comment.trim())fail('Напишите поручение',409);
  if(mode==='split'&&row.parentId)fail('Разбиение доступно для родительской задачи');
  const project=!row.projectAssigned&&copy?{path:'Проект не выбран. Уточни рабочую папку до выполнения.',name:'Без проекта'}:data.projects.find(p=>p.id===row.projectId);if(!project)fail('Проект недоступен',409);
  const parent=data.rows.find(r=>r.id===row.parentId);
  const instructions=mode==='split'?'Предложи разбиение этой задачи на самостоятельные обсуждаемые подзадачи. Создай дочерние строки через review-agent.mjs, указав parentId. Только план; не выполняй предложенные работы.':row.comment;
  const prompt=`Task ${id}: ${row.taskTitle}\nProject: ${project.path}\nPurpose: ${row.summary}\n${parent?`Parent ${parent.id}: ${parent.taskTitle}\nParent purpose: ${parent.summary}\nParent comment: ${parent.comment}\n`:''}\nRead ${path.join(this.workspace.root,reviewPath)} and ${path.join(this.workspace.toolsRoot,'skills/table-review/SKILL.md')}. Read project AGENTS.md.\n\nПоручение только для ${id}; сохранение и другие строки не являются разрешением:\n${instructions}\n\nВерсия комментария (replyTo): ${row.commentVersion}\nДо начала ответь **In progress.**; после результата **Needs review.**. Обновляй свою строку через ${path.join(this.workspace.toolsRoot,'scripts/review-agent.mjs')} с новой revision и replyTo из этого поручения. Сохраняй комментарии владельца. Подзадачи создавай с parentId: "${parent?.id||id}". Не отмечай новое замечание разобранным ответом на старую версию.`;
  const delivery=!copy&&row.assignee?.provider==='codex'&&row.assignee.sessionId?'codex':'manual';
  const requestId=hash([id,row.assignee,prompt]);
  return {id,title:row.taskTitle,project:row.projectName,assignee:row.assignee,threadId:delivery==='codex'?row.assignee.sessionId:null,cwd:project.path,prompt,requestId,commentVersion:row.commentVersion,delivery,mode};
 }
 recordDelivery(brief,record){
  const doc=this.store.read(reviewPath),meta=reviewMeta(doc.content);const m=meta.rows[brief.id]||={};
  m.delivery={assignee:brief.assignee,requestId:brief.requestId,commentVersion:brief.commentVersion,state:record.state,mode:brief.mode,at:new Date().toISOString()};
  this.store.write(reviewPath,doc.revision,withMeta(doc.content,meta),'user');
 }
}
