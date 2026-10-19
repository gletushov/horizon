import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {WorkspaceStore} from '../workspace-store.mjs';
const overview='reviews/agent-overview.md';
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-review-'));
 fs.mkdirSync(path.join(root,'reviews'));
 fs.writeFileSync(path.join(root,overview),'# Agents\n\n| Task / session | Summary / purpose | Latest updates / next action | Letushv comments and decisions |\n|---|---|---|---|\n| T01 · Existing | Keep purpose | **Needs review.** Existing result | &#32;мои&#32;слова&#32; |\n\nKeep tail.\n');
 const store=new WorkspaceStore(root);
 store.registerAgentSession({projectId:null,provider:'codex',sessionId:'11111111-1111-4111-8111-111111111111',taskTitle:'Existing',taskId:'T01'});
 const server=createApp(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port;
 async function request(route,data){const res=await fetch(url+route,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});return {status:res.status,body:await res.json()};}
 async function read(){const r=await request('/api/review');assert.equal(r.status,200,'The shared review workspace must be available');return r.body;}
 async function act(action,data={},expected=200){const d=await read();const r=await request('/api/review',{action,revision:d.revision,...data});assert.equal(r.status,expected,JSON.stringify(r.body));return r.body;}
 return {root,store,request,read,act};
}

test('owner creates independent subtopics; reload and promotion preserve discussion and old Markdown bytes',async t=>{
 const f=await fixture(t);const original=fs.readFileSync(path.join(f.root,overview),'utf8').split('\n').find(x=>x.startsWith('| T01'));
 let d=await f.act('create',{title:'Parser',projectId:null});const parent=d.createdId;
 const children=[];for(const title of ['Retries','Notifications','Proof']){d=await f.act('create',{parentId:parent,title});children.push(d.createdId);}
 d=await f.act('comment',{id:children[1],comment:'А если сутки не работает?',baseComment:''});
 assert.equal(d.rows.find(r=>r.id===children[1]).comment,'А если сутки не работает?');
 assert.equal(d.rows.find(r=>r.id===children[0]).comment,'');
 assert.equal(d.rows.filter(r=>r.parentId===parent).length,3);
 assert.equal(d.rows.find(r=>r.id===parent).state,'draft');
 d=await f.act('move',{id:children[1],parentId:null});
 assert.equal(d.rows.find(r=>r.id===children[1]).parentId,null);
 assert.equal(d.rows.find(r=>r.id===children[1]).comment,'А если сутки не работает?');
 assert.equal(new WorkspaceStore(f.root).review.read().rows.find(r=>r.id===children[0]).parentId,parent);
 assert.equal(fs.readFileSync(path.join(f.root,overview),'utf8').split('\n').find(x=>x.startsWith('| T01')),original);
 assert.match(fs.readFileSync(path.join(f.root,overview),'utf8'),/Keep tail\./);
});

test('agents create subtopics using the same review protocol and cannot overwrite owner text',async t=>{
 const f=await fixture(t);const doc=f.store.read(overview);
 const saved=f.store.agentReview(overview,doc.revision,[{task:'Agent proposal',parentId:'T01',updates:'**Needs review.** Two retries',comment:'overwrite'}]);
 const child=saved.rows.at(-1).id;const d=await f.read();
 assert.equal(d.rows.find(r=>r.id===child).parentId,'T01');
 assert.equal(d.rows.find(r=>r.id===child).projectId,null);
 assert.equal(d.rows.find(r=>r.id===child).comment,'');
 assert.equal(d.rows.find(r=>r.id==='T01').comment,' мои слова ');
});

test('invalid hierarchy and stale changes fail without changing the document',async t=>{
 const f=await fixture(t);let d=await f.act('create',{parentId:'T01',title:'Child'});const child=d.createdId;
 const before=fs.readFileSync(path.join(f.root,overview),'utf8');
 await f.act('create',{parentId:child,title:'Third level'},400);
 await f.act('move',{id:'T01',parentId:child},400);
 await f.act('move',{id:child,parentId:child},400);
 const stale=await f.request('/api/review',{action:'create',revision:'stale',title:'No write',projectId:null});assert.equal(stale.status,409);
 assert.equal(fs.readFileSync(path.join(f.root,overview),'utf8'),before);
});

test('acceptance is per result version and parent cannot close outstanding children',async t=>{
 const f=await fixture(t);let d=await f.act('create',{parentId:'T01',title:'Child'});const child=d.createdId;
 let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:child,updates:'**Needs review.** Done'}]);
 await f.act('accept',{id:'T01'},409);
 d=await f.act('accept',{id:child});assert.equal(d.rows.find(r=>r.id===child).state,'accepted');
 d=await f.act('accept',{id:'T01'});assert.equal(d.rows.find(r=>r.id==='T01').state,'accepted');
 doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:child,updates:'**Needs review.** Changed result'}]);
 d=await f.read();assert.equal(d.rows.find(r=>r.id===child).state,'review');assert.notEqual(d.rows.find(r=>r.id==='T01').state,'accepted');
});

test('reply to an older comment does not acknowledge a new one; history retains both',async t=>{
 const f=await fixture(t);let d=await f.act('comment',{id:'T01',comment:'First request',baseComment:' мои слова '});const first=d.rows[0].commentVersion;
 d=await f.act('comment',{id:'T01',comment:'Second request',baseComment:'First request'});
 let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**Needs review.** Answer to first',replyTo:first,acknowledgeComment:true}]);
 d=await f.read();assert.equal(d.rows[0].comment,'Second request');assert.equal(d.rows[0].commentAddressed,false);
 const h=await f.request('/api/review/history?id=T01');assert.equal(h.status,200);assert.ok(h.body.entries.some(e=>e.comment==='First request'));assert.ok(h.body.entries.some(e=>e.comment==='Second request'));
 await f.act('comment',{id:'T01',comment:'overwrite',baseComment:'First request'},409);
});

test('Z.ai assignment inherits into children and prevents sending to a historical Codex session',async t=>{
 const f=await fixture(t);let d=await f.act('assign',{id:'T01',assignee:{provider:'zai',sessionId:'sess_demo'}});
 d=await f.act('create',{parentId:'T01',title:'Z.ai subtask'});const child=d.createdId;
 d=await f.act('comment',{id:child,comment:'Inspect retries',baseComment:''});
 assert.equal(d.rows.find(r=>r.id===child).assignee.provider,'zai');
 const handoff=await f.request('/api/review/brief',{id:child,revision:d.revision});assert.equal(handoff.status,200);assert.equal(handoff.body.delivery,'manual');assert.match(handoff.body.prompt,/T01/);assert.match(handoff.body.prompt,/Inspect retries/);
 const codex=await f.request('/api/codex/preview',{ids:['T01']});assert.ok(codex.body.tasks[0].error,'Legacy dispatcher must not route a Z.ai assignment to Codex');
 d=await f.act('assign',{id:child,assignee:{provider:'claude',sessionId:'independent'}});
 await f.act('assign',{id:'T01',assignee:{provider:'other',sessionId:'new'}});
 d=await f.read();assert.equal(d.rows.find(r=>r.id===child).assignee.provider,'claude');
});

test('Z.ai sessions can register with stable task IDs',async t=>{
 const f=await fixture(t);const data={projectId:null,provider:'zai',sessionId:'sess_demo',taskTitle:'Z task'};
 const a=await f.request('/api/agent-session',data);assert.equal(a.status,200);const b=await f.request('/api/agent-session',data);assert.equal(b.body.taskId,a.body.taskId);
});

test('accept refuses a result updated since it was shown',async t=>{
 const f=await fixture(t);const shown=await f.read();let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**Needs review.** New result'}]);
 await f.act('accept',{id:'T01',resultVersion:shown.rows[0].resultVersion},409);
});

test('child protocol exposes current comment version, project and inherited recipient',async t=>{
 const f=await fixture(t);let d=await f.act('create',{parentId:'T01',title:'Shared contract'});const id=d.createdId;
 const row=f.store.read(overview).rows.find(r=>r.id===id);
 assert.equal(row.overviewProjectName,'Horizon');assert.match(row.commentVersion,/^[a-f0-9]{64}$/);
 assert.equal(row.currentAssignee.provider,'codex');
});

test('legacy closed row can reopen and inherited assignee can reset to parent',async t=>{
 const f=await fixture(t);let doc=f.store.read(overview);f.store.rowState(overview,doc.revision,'T01','closed');
 let d=await f.act('reopen',{id:'T01'});assert.notEqual(d.rows[0].state,'accepted');
 d=await f.act('create',{title:'Child',parentId:'T01'});const id=d.createdId;
 await f.act('assign',{id,assignee:{provider:'zai',sessionId:'z'}});d=await f.act('assign',{id,assignee:null});
 assert.equal(d.rows.find(r=>r.id===id).assignee.provider,'codex');
});

test('read and accepted review versions stop contributing to the navigation badge',async t=>{
 const f=await fixture(t);let response=await f.request('/api/agent-inbox');assert.equal(response.body.count,1);
 await f.act('seen',{id:'T01'});response=await f.request('/api/agent-inbox');assert.equal(response.body.count,0);
 let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**Needs review.** Fresh result'}]);
 response=await f.request('/api/agent-inbox');assert.equal(response.body.count,1);
 await f.act('accept',{id:'T01'});response=await f.request('/api/agent-inbox');assert.equal(response.body.count,0);
});

test('old pickup and reassignment do not attribute delivery to the new comment or recipient',async t=>{
 const f=await fixture(t);const old=await f.read();await f.act('comment',{id:'T01',baseComment:old.rows[0].comment,comment:'New request'});
 let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**In progress.** Old pickup',replyTo:old.rows[0].commentVersion}]);
 assert.equal(f.store.read(overview).rows[0].commentInProgress,false);
 const fresh=await f.read();const brief=f.store.review.brief({id:'T01',revision:fresh.revision});f.store.review.recordDelivery(brief,{state:'queued'});
 await f.act('assign',{id:'T01',assignee:{provider:'zai',sessionId:'new-recipient'}});
 const after=await f.read();assert.equal(after.rows[0].delivery,null);
});

test('quick capture appends a personal note without creating or dispatching a task',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.root,'letushv'));fs.writeFileSync(path.join(f.root,'letushv/inbox.md'),'# Мои мысли\n\nСуществующий текст.\n');
 const before=(await f.read()).rows.length;
 const saved=await f.request('/api/review/note',{projectId:null,text:'Новая мысль\nВторая строка'});assert.equal(saved.status,200);
 const source=fs.readFileSync(path.join(f.root,'letushv/inbox.md'),'utf8');assert.ok(source.startsWith('# Мои мысли\n\nСуществующий текст.\n'));assert.match(source,/Новая мысль\nВторая строка/);
 assert.equal((await f.read()).rows.length,before);assert.equal(fs.existsSync(path.join(f.root,'.runtime/dispatch')),false);
 const invalid=await f.request('/api/review/note',{projectId:'missing',text:'Do not write'});assert.equal(invalid.status,404);
});

test('pickup preserves the active comment until a substantive answer arrives',async t=>{
 const f=await fixture(t);let d=await f.read();const replyTo=d.rows[0].commentVersion;
 let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**In progress.** Started',replyTo}]);
 d=await f.read();assert.equal(d.rows[0].commentAddressed,false);assert.equal(d.rows[0].commentInProgress,true);
 doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**Needs review.** Answer',replyTo}]);d=await f.read();assert.equal(d.rows[0].commentAddressed,true);
});

test('a report from another provider does not silently reuse an old single Codex binding',async t=>{
 const f=await fixture(t);let doc=f.store.read(overview);f.store.agentReview(overview,doc.revision,[{id:'T01',updates:'**Needs review.** source: ZCode session sess_new. Result'}]);
 let d=await f.read();assert.equal(d.rows[0].assignee,null);assert.equal(d.rows[0].assigneeConflict,true);
 const legacy=await f.request('/api/codex/preview',{ids:['T01']});assert.ok(legacy.body.tasks[0].error);
 d=await f.act('assign',{id:'T01',assignee:{provider:'zai',sessionId:'sess_new'}});assert.equal(d.rows[0].assignee.provider,'zai');
});

test('document catalogue and personal notes remain accessible alongside agent overview',async t=>{
 const f=await fixture(t);
 fs.mkdirSync(path.join(f.root,'letushv'));
 fs.writeFileSync(path.join(f.root,'letushv/inbox.md'),'# My notes\n\nKeep this thought.\n');
 const listing=await f.request('/api/documents');
 assert.equal(listing.status,200,JSON.stringify(listing.body));
 assert.ok(listing.body.documents.some(d=>d.path===overview));
 assert.ok(listing.body.documents.some(d=>d.path==='letushv/inbox.md'));
 const note=await f.request('/api/document?path=letushv%2Finbox.md');
 assert.equal(note.status,200);assert.match(note.body.content,/Keep this thought/);
 const review=await f.request('/api/document?path='+encodeURIComponent(overview));
 assert.equal(review.status,200);assert.equal(review.body.rows[0].currentAssignee.provider,'codex');
});
