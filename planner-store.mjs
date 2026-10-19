import {randomUUID} from 'node:crypto';
import './public/planner-core.js';
const P=globalThis.HorizonPlanner;
const encode = value => JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
const validId = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const noteValid = note => {if(typeof note!=='string'||note.length>100000||/<!--\s*\/?horizon(?:-note|-day-note|:)/.test(note))fail('Некорректная заметка: служебные маркеры недопустимы.');};
const textValid = text => {if(typeof text!=='string'||!text.trim()||text.length>1000||/[\r\n]/.test(text)||/<!--\s*horizon:/.test(text))fail('Укажите текст задачи одной строкой.');};
function readPlan(store,path) {
  if(!P.isPath(path))fail('Выберите документ горизонта.');
  try {return store.read(path);}catch(e){if(e.status!==404||!path.startsWith('planner/days/'))throw e;return {path,revision:null,content:`# Day · ${path.slice(13,-3)}\n\n`,title:'Day',rows:[]};}
}
function writePlan(store,doc,revision,content) {
  if(doc.revision!==revision)fail('План изменился. Черновик сохранён; перечитайте файл для сравнения.',409);
  return doc.revision===null?store.create(doc.path,content):store.save(doc.path,revision,content);
}
export function readDay(store,date) {
  if(!P.dateValid(date))fail('Некорректная дата.');
  const doc=readPlan(store,`planner/days/${date}.md`);return {...doc,date,note:P.dayNote(doc.content),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
}
export function saveDay(store,{date,revision,note}) {
  noteValid(note);const doc=readDay(store,date);const saved=writePlan(store,doc,revision,P.setDayNote(doc.content,note));return {...saved,date,note:P.dayNote(saved.content),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
}
export function editTask(store,data) {
  const {path,revision,id,index,childIndex,childId,createId,addChildId,action}=data;
  const patch=data.patch??(action==='addComment'?{}:null);
  const doc=readPlan(store,path),existing=P.tasks(doc.content);
  if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('Некорректные изменения задачи.');
  if('text'in patch)textValid(patch.text);if('addChild'in patch)textValid(patch.addChild);
  for(const value of [id,childId,createId,addChildId])if(value!==undefined&&!validId(value))fail('Некорректный ID.');
  if(action==='add'&&createId){const matches=existing.filter(t=>t.id===createId);if(matches.length){if(matches.length!==1||matches[0].invalid||matches[0].text!==patch?.text?.trim())fail('ID уже используется другой задачей.',409);return {document:doc,task:matches[0]};}}
  const current=id?existing.find(t=>t.id===id):existing.find(t=>t.index===index);
  if(current?.invalid || id && existing.filter(t=>t.id===id).length>1)fail('Метаданные задачи повреждены или ID неоднозначен.',409);
  if(action==='addComment'){
    const comment=data.comment;
    if(!comment||!validId(comment.id)||typeof comment.text!=='string'||!comment.text.trim()||comment.text.trim().length>10000)fail('Комментарий должен содержать от 1 до 10000 символов.');
    const previous=current?.comments.find(c=>c.id===comment.id);
    if(previous){if(previous.text!==comment.text.trim())fail('ID комментария уже используется.',409);return {document:doc,task:current};}
  }
  if(patch?.addChild&&addChildId){const children=current?.children.filter(c=>c.id===addChildId)||[];if(children.length){if(children.length!==1||children[0].text!==patch.addChild.trim())fail('ID подзадачи уже используется.',409);return {document:doc,task:current};}}
  if(doc.revision!==revision)fail('План изменился. Черновик сохранён; перечитайте файл для сравнения.',409);
  if(!patch||typeof patch!=='object'||Array.isArray(patch))fail('Некорректные изменения задачи.');
  for(const key of Object.keys(patch))if(!['text','done','color','highlight','due','note','addChild'].includes(key))fail('Неизвестное свойство задачи.');
  if('text'in patch)textValid(patch.text);if('addChild'in patch)textValid(patch.addChild);
  if('note'in patch)noteValid(patch.note);
  if('color'in patch&&!P.colors.includes(patch.color))fail('Неизвестный цвет.');
  if('highlight'in patch&&typeof patch.highlight!=='boolean'||'done'in patch&&typeof patch.done!=='boolean')fail('Некорректный статус.');
  if('due'in patch&&patch.due!==null&&!P.dateValid(patch.due))fail('Некорректный срок.');
  let content=doc.content;
  if(action==='add'){textValid(patch.text);content=content.trimEnd()+'\n\n- [ ] '+patch.text.trim()+'\n';}
  const list=P.tasks(content);
  const task=action==='add'?list.at(-1):id?list.find(t=>t.id===id):list.find(t=>t.index===index);
  if(!task||action!=='add'&&id&&list.filter(t=>t.id===id).length!==1)fail('Задача исчезла или ID неоднозначен. Обновите горизонт.',409);
  if(task.invalid)fail('Метаданные задачи повреждены. Исправьте исходник перед редактированием.',409);
  const lines=content.split('\n');const metadata={id:task.id||(action==='add'?createId:null)||randomUUID(),color:task.color,highlight:task.highlight,due:task.due,comments:task.comments};
  if(action==='addComment')metadata.comments=[...task.comments,{id:data.comment.id,text:data.comment.text.trim(),author:'Владелец',createdAt:new Date().toISOString()}];
  if(childIndex!==undefined||childId!==undefined) {
    if(Object.keys(patch).some(k=>!['text','done','color'].includes(k)))fail('Для подзадачи доступны текст, статус и цвет.');
    const matching=task.children.filter(c=>childId?c.id===childId:c.index===childIndex);const child=matching[0];if(matching.length!==1||!child)fail('Подзадача исчезла.',409);
    const meta={id:child.id||randomUUID(),color:patch.color??child.color};
    lines[child.index]=`${child.indent}- [${(patch.done??child.done)?'x':' '}] ${patch.text??child.text} <!-- horizon:${encode(meta)} -->`;
  } else {
    for(const key of ['color','highlight','due'])if(key in patch)metadata[key]=patch[key];
    lines[task.index]=`- [${(patch.done??task.done)?'x':' '}] ${patch.text??task.text}`;
  }
  const remove=new Set(task.metaIndex===null?[]:[task.metaIndex]);
  if('note'in patch)task.noteIndices.forEach(i=>remove.add(i));
  const body=lines.slice(task.index+1,task.end).filter((_,i)=>!remove.has(task.index+1+i));
  if('note'in patch&&patch.note)body.push('  <!-- horizon-note -->',...patch.note.split('\n').map(l=>'  '+l),'  <!-- /horizon-note -->');
  if(patch.addChild)body.push('  - [ ] '+patch.addChild.trim()+' <!-- horizon:'+encode({id:addChildId||randomUUID(),color:task.color})+' -->');
  const block=[lines[task.index],`  <!-- horizon:${encode(metadata)} -->`,...body];
  lines.splice(task.index,task.end-task.index,...block);
  const saved=writePlan(store,doc,revision,lines.join('\n'));
  return {document:saved,task:P.tasks(saved.content).find(t=>t.id===metadata.id)};
}
