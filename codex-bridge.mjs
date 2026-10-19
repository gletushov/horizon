import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
const failure=(message,status=503)=>Object.assign(new Error(message),{status});
export class CodexBridge {
  constructor(root){this.root=root;this.child=null;this.pending=new Map();this.next=1;this.ready=null;this.mode=null;this.error=null;this.records=new Map();}
  async connect(){
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      const sock=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'app-server-control/app-server-control.sock');
      const shared=fs.existsSync(sock);
      const binary=process.env.HORIZON_CODEX_BIN||path.join(os.homedir(),'.local/bin/codex');
      this.mode=shared?'shared':'managed';
      const child=spawn(binary,shared?['app-server','proxy','--sock',sock]:['app-server','--stdio'],{stdio:['pipe','pipe','pipe']});this.child=child;
      child.stdout.setEncoding('utf8');let buffer='';
      child.stdout.on('data',chunk=>{buffer+=chunk;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.method&&message.id!==undefined){
          child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Horizon cannot approve this request. Continue in Codex.'}})+'\n');
          for(const record of this.records.values())if(record.threadId===message.params?.threadId){record.state='blocked';record.error='Требуется разрешение или ответ. Продолжите задачу в Codex.';this.saveRecord(record);}continue;
        }
        if(message.method==='turn/completed')for(const record of this.records.values())if(record.threadId===message.params?.threadId&&record.turnId&&record.turnId===message.params?.turn?.id){record.turnId=message.params.turn.id;record.state=message.params.turn.status;record.error=message.params.turn.error?.message||record.error;this.saveRecord(record);}
        const pending=this.pending.get(message.id);if(pending){this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(failure(message.error.message)):pending.resolve(message.result);}
      }});
      const closed=()=>{if(this.child!==child)return;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(failure('Codex disconnected. Check the task before sending again.'));}this.pending.clear();this.child=null;this.ready=null;this.error='Codex disconnected';};
      child.on('error',closed);child.on('exit',closed);child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
      await this.call('initialize',{clientInfo:{name:'horizon',title:'Horizon',version:'0.2.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');this.error=null;
    })();try{await this.ready;}catch(error){this.error=error.message;this.child?.kill();this.child=null;this.ready=null;throw error;}
  }
  close(){this.child?.kill();this.child=null;this.ready=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(failure('Horizon stopped'));}this.pending.clear();}
  async status(){try{await this.connect();return {available:true,mode:this.mode,label:this.mode==='managed'?'Codex connected · desktop sessions may be locked':'Codex connected'};}catch(error){return {available:false,error:error.message};}}
  call(method,params){return new Promise((resolve,reject)=>{if(!this.child)return reject(failure('Codex unavailable'));const id=this.next++;const timer=setTimeout(()=>{this.pending.delete(id);reject(failure('Codex timed out. Check the task before sending again.'));},15000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  async list(cwd){await this.connect();const result=await this.call('thread/list',{cwd,limit:100,archived:false,sortKey:'updated_at'});return {available:true,threads:(result.data||[]).map(t=>({id:t.id,title:t.name||t.preview||t.id,status:t.status?.type||'unknown'}))};}
  recordPath(id){if(typeof id!=='string'||!(/^[a-f0-9-]{36}$/i.test(id)||/^[a-f0-9]{64}$/.test(id)))throw failure('Invalid request ID',400);return path.join(this.root,'.runtime','dispatch',id+'.json');}
  saveRecord(record){const file=this.recordPath(record.requestId);fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});}
  getRecord(id){const file=this.recordPath(id);if(!fs.existsSync(file))return null;const record=JSON.parse(fs.readFileSync(file,'utf8'));if(record.state==='pending'&&!record.turnId&&/already has an active writer/.test(record.error||''))record.state='not_sent';return record;}
  async send({threadId,prompt,requestId},cwd){
    if(typeof threadId!=='string'||typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)throw failure('Invalid prompt',400);
    const file=this.recordPath(requestId),promptHash=createHash('sha256').update(prompt).digest('hex');
    if(fs.existsSync(file)){const record=this.getRecord(requestId);if(record.threadId!==threadId||record.promptHash!==promptHash)throw failure('Request ID already used for another prompt',409);if(record.state==='pending')throw failure('Previous send is uncertain. Check Codex; it will not be resent automatically.',409);if(record.state!=='not_sent')return record;}
    await this.connect();const meta=await this.call('thread/read',{threadId,includeTurns:false});
    if(path.resolve(meta.thread.cwd)!==path.resolve(cwd))throw failure('Task belongs to another project',403);
    // Queue a follow-up without resuming or taking the writer lock from the desktop app.
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const record={threadId,requestId,state:'pending',createdAt:new Date().toISOString(),promptHash};
    try{if(fs.existsSync(file)&&this.getRecord(requestId)?.state==='not_sent')fs.unlinkSync(file);fs.writeFileSync(file,JSON.stringify(record),{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')throw failure('This request is already being sent',409);throw error;}
    this.records.set(requestId,record);
    try{const result=await this.call('thread/queue/add',{threadId,clientUserMessageId:randomUUID(),input:[{type:'text',text:prompt,text_elements:[]}]});record.state='queued';record.queuedSubmissionId=result.queuedSubmission.id;this.saveRecord(record);return record;}
    catch(error){record.error=error.message;this.saveRecord(record);throw error;}
  }
}
