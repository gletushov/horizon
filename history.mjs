import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
let stamp=0;
export class History {
 constructor(root){this.root=root;}
 statePath(relative){return path.join(this.root,'.horizon','state',hash(relative)+'.json');}
 state(relative){const file=this.statePath(relative);return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{rows:{}};}
 saveState(relative,state){const file=this.statePath(relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
 observe(doc,actor='external'){
  const state=this.state(doc.path);if(state.revision!==doc.revision){
   const source=!state.revision?'initial':actor;stamp=Math.max(Date.now(),stamp+1);const id=`${stamp}-${randomUUID()}.md`,dir=path.join(this.root,'.history',doc.path);
   fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,id),doc.content,{mode:0o600,flag:'wx'});
   fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,revision:doc.revision,createdAt:new Date(stamp).toISOString(),actor:source}),{mode:0o600,flag:'wx'});
   for(const row of doc.rows){
    const current=copy(row.agentContent ?? row.agent);let meta=state.rows[row.id];
    if(!meta)meta=state.rows[row.id]={seenAgent:copy(row.agent),lastAgent:copy(row.agent),seenAgentContent:copy(current),lastAgentContent:copy(current),status:'working'};
    const previous=meta.lastAgentContent ?? meta.lastAgent;
    if(!same(previous,current)){
     if(actor==='user'){meta.seenAgent=copy(row.agent);meta.seenAgentContent=copy(current);}
     if(meta.status==='closed')meta.status='review';meta.lastAgent=copy(row.agent);meta.lastAgentContent=copy(current);if(actor==='agent'||actor==='external')meta.status='review';
    }
   }
   state.revision=doc.revision;state.latestVersion=id;this.saveState(doc.path,state);
  }
  return {...doc,rows:doc.rows.map(row=>{
   const meta=state.rows[row.id]||{};const current=copy(row.agentContent ?? row.agent);const seen=meta.seenAgentContent ?? meta.seenAgent ?? current;
   const before=meta.seenAgent ?? row.agent;const beforeContent=meta.seenAgentContent ?? (row.schema==='task-summary'&&typeof before==='string'?current:before);
   return {...row,commentInProgress:Boolean(row.comment && meta.inProgressComment===row.comment && /^\*\*In progress\./i.test(row.updates||row.agent||'')),commentAcknowledged:Boolean(row.comment && meta.acknowledgedComment===row.comment),status:meta.status||'working',updated:!same(seen,current),beforeAgent:before,beforeAgentContent:copy(beforeContent)};
  })};
 }
 list(relative){const dir=path.join(this.root,'.history',relative);if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(id=>/^\d+-[a-f0-9-]+\.md$/.test(id)).sort((a,b)=>Number(b.split('-')[0])-Number(a.split('-')[0])).slice(0,200).map(id=>{
  const meta=path.join(dir,id+'.json');return fs.existsSync(meta)?JSON.parse(fs.readFileSync(meta,'utf8')):{id,createdAt:new Date(Number(id.split('-')[0])).toISOString(),actor:'unknown'};
 });}
 version(relative,id){if(typeof id!=='string'||!/^\d+-[a-f0-9-]+\.md$/.test(id))fail('Недоступная версия',403);const file=path.join(this.root,'.history',relative,id);if(!fs.existsSync(file))fail('Версия не найдена',404);if(fs.lstatSync(file).isSymbolicLink())fail('Недоступная версия',403);return {id,content:fs.readFileSync(file,'utf8')};}
 mark(doc,id,action){
  const row=doc.rows.find(r=>r.id===id);if(!row)fail('Строка не найдена',404);const state=this.state(doc.path);const meta=state.rows[id]||{};const current=copy(row.agentContent ?? row.agent);
  if(action==='seen'){meta.seenAgent=copy(row.agent);meta.seenAgentContent=copy(current);}
  else if(['working','review','closed'].includes(action)){meta.status=action;if(action==='closed'){meta.seenAgent=copy(row.agent);meta.seenAgentContent=copy(current);}}
  else fail('Неизвестное действие');
  state.rows[id]=meta;this.saveState(doc.path,state);
 }
 move(from,to){const old=this.statePath(from);if(fs.existsSync(old)){fs.mkdirSync(path.dirname(this.statePath(to)),{recursive:true});fs.renameSync(old,this.statePath(to));}const dir=path.join(this.root,'.history',from),next=path.join(this.root,'.history',to);if(fs.existsSync(dir)){fs.mkdirSync(next,{recursive:true,mode:0o700});for(const file of fs.readdirSync(dir))fs.renameSync(path.join(dir,file),path.join(next,file));fs.rmdirSync(dir);}}
}
