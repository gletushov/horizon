import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createApp} from '../server.mjs';
import {WorkspaceStore} from '../workspace-store.mjs';

async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-daily-'));
 fs.mkdirSync(path.join(root,'docs'));fs.mkdirSync(path.join(root,'reviews'));
 fs.writeFileSync(path.join(root,'docs/a.md'),'# Alpha\n\nUntouched text.\n');
 fs.writeFileSync(path.join(root,'reviews/agent-overview.md'),'# Agents\n\n| Task / session | Summary / purpose | Latest updates / next action | Letushv comments and decisions |\n|---|---|---|---|\n| T01 · Task | Purpose | **Needs review.** Result | Do this |\n');
 const store=new WorkspaceStore(root);
 let data=store.review.read();store.review.act({action:'project',id:'T01',projectId:null,revision:data.revision});
 const server=createApp(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port;
 const request=async(route,data)=>{const res=await fetch(url+route,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});return {status:res.status,body:await res.json()};};
 return {root,store,url,request};
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=';

test('image upload gives a portable Markdown reference and serves bytes; moving the document keeps it readable',async t=>{
 const f=await fixture(t);const before=f.store.read('docs/a.md');
 const upload=await f.request('/api/images',{path:before.path,name:'снимок.png',data:png});
 assert.equal(upload.status,200,'Image insertion must be available');
 assert.match(upload.body.markdown,/!\[снимок\]\(<\.\.\/assets\/horizon-images\//);
 assert.equal(f.store.read(before.path).content,before.content,'Uploading must not replace document text');
 const saved=f.store.save(before.path,before.revision,before.content+'\n'+upload.body.markdown+'\n');
 const image=await fetch(f.url+upload.body.url);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),Buffer.from(png,'base64'));
 const renamed=f.store.rename(saved.path,saved.revision,'docs/deeper/moved.md');
 assert.match(renamed.content,/\.\.\/\.\.\/assets\/horizon-images\//,'Moved document must still resolve its image');
 assert.equal(new WorkspaceStore(f.root).read(renamed.path).content,renamed.content);
 const listing=await f.request('/api/documents');assert.ok(listing.body.documents.every(d=>/\.(md|html)$/.test(d.path)));
});

test('images cannot write through symlinks, outside the project, or accept disguised active content',async t=>{
 const f=await fixture(t);
 for(const data of ['PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=','not-base64']){
  const r=await f.request('/api/images',{path:'docs/a.md',name:'unsafe.png',data});assert.equal(r.status,400);
 }
 fs.mkdirSync(path.join(f.root,'assets'));fs.symlinkSync(os.tmpdir(),path.join(f.root,'assets/horizon-images'));
 assert.equal((await f.request('/api/images',{path:'docs/a.md',name:'a.png',data:png})).status,403);
 assert.equal((await f.request('/api/images',{path:'../a.md',name:'a.png',data:png})).status,403);
 assert.equal(f.store.read('docs/a.md').content,'# Alpha\n\nUntouched text.\n');
});

test('connected project stores its image locally and cannot insert into the read-only HTML reader',async t=>{
 const f=await fixture(t);const other=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-images-project-'));t.after(()=>fs.rmSync(other,{recursive:true,force:true}));
 fs.writeFileSync(path.join(other,'a.md'),'# Other\n');fs.writeFileSync(path.join(other,'a.html'),'<h1>Other</h1>');
 const conn=await f.request('/api/connect-project',{name:'Other',directory:other});
 const prefix='projects/'+conn.body.id+'/';const r=await f.request('/api/images',{path:prefix+'a.md',name:'a.png',data:png});assert.equal(r.status,200);
 assert.ok(fs.existsSync(path.join(other,r.body.path.slice(prefix.length))));assert.ok(!fs.existsSync(path.join(f.root,'assets')));
 assert.equal((await f.request('/api/images',{path:prefix+'a.html',name:'a.png',data:png})).status,400);
});

test('moving a whole folder rebases managed images and keeps Markdown readable',async t=>{
 const f=await fixture(t);const doc=f.store.read('docs/a.md');
 const upload=await f.request('/api/images',{path:doc.path,name:'a.png',data:png});assert.equal(upload.status,200);
 f.store.save(doc.path,doc.revision,doc.content+upload.body.markdown+'\n');
 fs.mkdirSync(path.join(f.root,'archive'));
 const current=f.store.folder('docs');f.store.folder('docs',{action:'move',revision:current.revision,destination:'archive/docs'});
 assert.match(f.store.read('archive/docs/a.md').content,/\.\.\/\.\.\/assets\/horizon-images\//);
});

test('turning note content into a document at another depth keeps managed images portable',async t=>{
 const f=await fixture(t);const doc=f.store.read('docs/a.md'),image=await f.request('/api/images',{path:doc.path,name:'note.png',data:png});assert.equal(image.status,200);
 const created=await f.request('/api/create',{path:'docs/deeper/copied.md',sourcePath:doc.path,content:image.body.markdown});assert.equal(created.status,200);
 assert.match(created.body.content,/\.\.\/\.\.\/assets\/horizon-images\//);assert.equal(f.store.read(doc.path).content,doc.content);
});

test('one continuous note survives reload, adds newest first, deduplicates retry and retains creation date on edit',async t=>{
 const f=await fixture(t);fs.mkdirSync(path.join(f.root,'letushv'));fs.writeFileSync(path.join(f.root,'letushv/inbox.md'),'# My existing thoughts\n');
 let r=await f.request('/api/notes');assert.equal(r.status,200);assert.deepEqual(r.body.entries,[]);
 const id='11111111-1111-4111-8111-111111111111';
 const add=await f.request('/api/notes',{action:'add',revision:r.body.revision,id,text:'First **thought**'});assert.equal(add.status,200);const date=add.body.entries[0].createdAt;
 const retry=await f.request('/api/notes',{action:'add',revision:r.body.revision,id,text:'First **thought**'});assert.equal(retry.status,200);assert.equal(retry.body.entries.length,1);
 const second=await f.request('/api/notes',{action:'add',revision:add.body.revision,id:'22222222-2222-4222-8222-222222222222',text:'Second\n\nWith image later.'});assert.equal(second.status,200);
 assert.equal(second.body.entries[0].text,'Second\n\nWith image later.');
 const edit=await f.request('/api/notes',{action:'edit',revision:second.body.revision,id,text:'Edited'});assert.equal(edit.status,200);assert.equal(edit.body.entries.find(e=>e.id===id).createdAt,date);
 const read=await f.request('/api/notes');assert.deepEqual(read.body.entries,edit.body.entries);
 assert.match(fs.readFileSync(path.join(f.root,read.body.path),'utf8'),/Edited/);
 assert.equal(fs.readFileSync(path.join(f.root,'letushv/inbox.md'),'utf8'),'# My existing thoughts\n');
 const stale=await f.request('/api/notes',{action:'edit',revision:second.body.revision,id,text:'Lose edit'});assert.equal(stale.status,409);
 assert.equal((await f.request('/api/notes')).body.entries.find(e=>e.id===id).text,'Edited');
});

test('note capture rejects empty input and never erases a pre-existing unstructured document',async t=>{
 const f=await fixture(t);let r=await f.request('/api/notes');assert.equal(r.status,200);
 assert.equal((await f.request('/api/notes',{action:'add',revision:r.body.revision,id:'33333333-3333-4333-8333-333333333333',text:'  '})).status,400);
 fs.mkdirSync(path.dirname(path.join(f.root,r.body.path)),{recursive:true});fs.writeFileSync(path.join(f.root,r.body.path),'# Older note\n\nKeep this text.\n');
 r=await f.request('/api/notes');const added=await f.request('/api/notes',{action:'add',revision:r.body.revision,id:'33333333-3333-4333-8333-333333333333',text:'New thought'});
 assert.equal(added.status,200);assert.match(fs.readFileSync(path.join(f.root,r.body.path),'utf8'),/Keep this text\./);
});

test('an image can be captured before the first note without creating or changing note text',async t=>{
 const f=await fixture(t);const notes=await f.request('/api/notes');assert.equal(notes.status,200);
 const image=await f.request('/api/images',{path:notes.body.path,name:'thought.png',data:png});assert.equal(image.status,200);
 assert.equal((await f.request('/api/notes')).body.revision,null);
 const saved=await f.request('/api/notes',{action:'add',revision:null,id:'44444444-4444-4444-8444-444444444444',text:image.body.markdown});assert.equal(saved.status,200);
 assert.match(saved.body.entries[0].text,/assets\/horizon-images/);
});

test('copying a draft without a project never silently picks a workspace or changes the saved comment',async t=>{
 const f=await fixture(t);let review=f.store.review.read();const created=f.store.review.act({action:'create',revision:review.revision,title:'Unassigned',comment:'Saved words'});
 const copy=await f.request('/api/review/brief',{id:created.createdId,revision:created.revision,copy:true,comment:'Unsaved words'});assert.equal(copy.status,200);
 assert.match(copy.body.prompt,/Проект не выбран/);assert.match(copy.body.prompt,/Unsaved words/);
 assert.equal(f.store.review.read().rows.find(r=>r.id===created.createdId).comment,'Saved words');
});

test('copy task works without a session and for Codex and Z.ai without recording delivery',async t=>{
 const f=await fixture(t);
 for(const assignee of [null,{provider:'codex',sessionId:'11111111-1111-4111-8111-111111111111'},{provider:'zai',sessionId:'z-test'}]){
  let data=f.store.review.read();f.store.review.act({action:'assign',id:'T01',revision:data.revision,assignee});data=f.store.review.read();
  const copy=await f.request('/api/review/brief',{id:'T01',revision:data.revision,copy:true});assert.equal(copy.status,200);
  assert.match(copy.body.prompt,/Do this/);assert.match(copy.body.prompt,/replyTo/);assert.match(copy.body.prompt,/Task T01/);assert.equal(copy.body.delivery,'manual');
  assert.equal(f.store.review.read().rows[0].delivery,null);
 }
});

test('session overview groups named sessions by project and retains an unassigned registered session',async t=>{
 const f=await fixture(t);
 f.store.registerAgentSession({projectId:null,provider:'zai',sessionId:'z-session',taskId:'T01',taskTitle:'A title'});
 const result=await f.request('/api/sessions');assert.equal(result.status,200);
 assert.ok(result.body.sessions.some(s=>s.provider==='zai'&&s.sessionId==='z-session'&&s.taskIds.includes('T01')));
 // Registration without a task is a session inventory entry; it must not create a task.
 const count=f.store.review.read().rows.length;
 const orphan=await f.request('/api/sessions',{projectId:null,provider:'zai',sessionId:'z-alone',title:'No task yet'});assert.equal(orphan.status,200);
 assert.equal(f.store.review.read().rows.length,count);
 assert.deepEqual((await f.request('/api/sessions')).body.sessions.find(s=>s.sessionId==='z-alone').taskIds,[]);
});

test('tabs deduplicate, retain opening order across reload, rebase folders and close to a neighbour',()=>{
 const context={URL};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../public/editor-core.js',import.meta.url),'utf8'),context);
 assert.equal(typeof context.HorizonEditor.tabs,'function','Open documents must have persistent tabs');
 const tabs=context.HorizonEditor.tabs(['docs/a.md','docs/b.md','docs/a.md']);
 tabs.open('docs/b.md');tabs.open('docs/c.html');assert.deepEqual(Array.from(tabs.paths),['docs/a.md','docs/b.md','docs/c.html']);
 const reload=context.HorizonEditor.tabs(JSON.parse(JSON.stringify(tabs.paths)));reload.remap('docs','notes');
 assert.equal(reload.close('notes/b.md'),'notes/c.html');assert.deepEqual(Array.from(reload.paths),['notes/a.md','notes/c.html']);
});

test('document links resolve encoded spaces and heading fragments without escaping a connected project',()=>{
 const context={URL};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../public/editor-core.js',import.meta.url),'utf8'),context);
 assert.equal(typeof context.HorizonEditor.documentLink,'function','Document links must retain heading targets');
 const link=context.HorizonEditor.documentLink('projects/p/docs/a.md','../My%20file.md#next-step');assert.equal(link.path,'projects/p/My file.md');assert.equal(link.heading,'next-step');
 assert.equal(context.HorizonEditor.documentLink('projects/p/a.md','../../else.md'),null);
 assert.equal(context.HorizonEditor.documentLink('docs/a.md','#heading').path,'docs/a.md');
});
