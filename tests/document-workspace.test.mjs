import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-editor-'));
  fs.mkdirSync(path.join(root,'agents/source'),{recursive:true});
  fs.mkdirSync(path.join(root,'docs'),{recursive:true});
  fs.writeFileSync(path.join(root,'agents/source/note.md'),'# Note\n\nKeep **this quote** exactly.\n');
  const app=createApp(root);await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+app.address().port;
  const request=async(url,data)=>{const response=await fetch(origin+url,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return {status:response.status,body:await response.json()};};
  const get=async(url)=>{const r=await request(url);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const post=async(url,data)=>{const r=await request(url,data);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  return {root,request,get,post};
}
async function annotate(f,path='agents/source/note.md') {
  const doc=await f.get('/api/document?path='+encodeURIComponent(path));
  const notes=await f.get('/api/annotations?path='+encodeURIComponent(path));
  const saved=await f.post('/api/annotations',{path,revision:notes.revision,sourceRevision:doc.revision,action:'add',quote:'this quote',prefix:'Keep ',suffix:' exactly.',start:9,text:'Make it clearer'});
  return {doc,notes,saved};
}
test('the document date comes from the source file, remains stable on reading, and follows edits',async t=>{
  const f=await fixture(t),relative='agents/source/note.md',file=path.join(f.root,relative);
  const original=new Date('2026-09-30T12:00:00.000Z');fs.utimesSync(file,original,original);
  const doc=await f.get('/api/document?path='+relative);assert.equal(doc.modifiedAt,original.toISOString());
  assert.equal((await f.get('/api/document?path='+relative)).modifiedAt,doc.modifiedAt);
  const edited=await f.post('/api/document',{path:relative,revision:doc.revision,content:doc.content+'\nEdit\n'});
  assert.equal(edited.modifiedAt,fs.statSync(file).mtime.toISOString());assert.notEqual(edited.modifiedAt,doc.modifiedAt);
});
test('comments persist outside Markdown, export exact source and quotes for an agent, and reject stale writes',async t=>{
  const f=await fixture(t),{doc,notes,saved}=await annotate(f);
  assert.equal(saved.comments.length,1);assert.equal(saved.comments[0].quote,'this quote');
  assert.equal(fs.readFileSync(path.join(f.root,doc.path),'utf8'),doc.content);
  assert.deepEqual((await f.get('/api/annotations?path='+doc.path)).comments,saved.comments);
  const exported=await f.get('/api/annotations/export?path='+doc.path);
  assert.equal(exported.document.content,doc.content);assert.equal(exported.document.sourcePath,path.join(f.root,doc.path));
  assert.match(exported.text,/this quote/);assert.match(exported.text,/Make it clearer/);
  const stale=await f.request('/api/annotations',{path:doc.path,revision:notes.revision,sourceRevision:doc.revision,action:'add',quote:'Keep',text:'stale'});
  assert.equal(stale.status,409);assert.equal((await f.get('/api/annotations?path='+doc.path)).comments.length,1);
  await f.post('/api/document',{path:doc.path,revision:doc.revision,content:'# Changed\n'});
  const staleSource=await f.request('/api/annotations',{path:doc.path,revision:saved.revision,sourceRevision:doc.revision,action:'add',quote:'Keep',text:'stale quote'});
  assert.equal(staleSource.status,409);
  const edited=await f.post('/api/annotations',{path:doc.path,revision:saved.revision,action:'edit',id:saved.comments[0].id,text:'Keep discussion even after quote disappears'});
  assert.equal(edited.comments[0].quote,'this quote');
  const deleted=await f.post('/api/annotations',{path:doc.path,revision:edited.revision,action:'delete',id:edited.comments[0].id});
  assert.equal(deleted.comments.length,0);
  const restored=await f.post('/api/annotations',{path:doc.path,revision:deleted.revision,action:'restore',id:edited.comments[0].id});
  assert.deepEqual(restored.comments,edited.comments);
});
test('file rename and move preserve comment IDs and history; delete/restore isolate a replacement file',async t=>{
  const f=await fixture(t),{doc,saved}=await annotate(f);
  const moved=await f.post('/api/rename',{path:doc.path,revision:doc.revision,destination:'docs/renamed.md'});
  assert.deepEqual((await f.get('/api/annotations?path='+moved.path)).comments,saved.comments);
  assert.ok((await f.get('/api/folders')).folders.some(folder=>folder.path==='agents/source'),'empty source folder stays available as a drop target');
  const removed=await f.post('/api/delete',{path:moved.path,revision:moved.revision});
  await f.post('/api/create',{path:moved.path,content:'# Replacement\n'});
  assert.equal((await f.get('/api/annotations?path='+moved.path)).comments.length,0);
  assert.equal((await f.request('/api/restore',removed)).status,409);
  const replacement=await f.get('/api/document?path='+moved.path);
  await f.post('/api/delete',{path:replacement.path,revision:replacement.revision});
  const restored=await f.post('/api/restore',removed);
  assert.equal(restored.content,doc.content);assert.deepEqual((await f.get('/api/annotations?path='+moved.path)).comments,saved.comments);
});
test('folder create, rename/move, deletion and undo keep nested documents, empty folders and comments',async t=>{
  const f=await fixture(t),{doc,saved}=await annotate(f);
  await f.post('/api/folder',{action:'create',path:'agents/source/empty'});
  const folder=await f.get('/api/folder?path=agents/source');
  const moved=await f.post('/api/folder',{action:'move',path:folder.path,revision:folder.revision,destination:'docs/renamed'});
  assert.equal(moved.path,'docs/renamed');assert.ok(fs.statSync(path.join(f.root,'docs/renamed/empty')).isDirectory());
  assert.equal((await f.get('/api/document?path=docs/renamed/note.md')).content,doc.content);
  assert.deepEqual((await f.get('/api/annotations?path=docs/renamed/note.md')).comments,saved.comments);
  const removed=await f.post('/api/folder',{action:'delete',path:moved.path,revision:moved.revision});
  assert.equal(fs.existsSync(path.join(f.root,moved.path)),false);
  const restored=await f.post('/api/folder',{action:'restore',id:removed.id});
  assert.equal(restored.path,moved.path);assert.deepEqual((await f.get('/api/annotations?path=docs/renamed/note.md')).comments,saved.comments);
});
test('folder writes reject stale trees, collisions, cycles and protected or non-Markdown contents before moving anything',async t=>{
  const f=await fixture(t);const folder=await f.get('/api/folder?path=agents/source');
  await f.post('/api/document',{path:'agents/source/note.md',revision:(await f.get('/api/document?path=agents/source/note.md')).revision,content:'changed'});
  assert.equal((await f.request('/api/folder',{action:'move',path:folder.path,revision:folder.revision,destination:'docs/moved'})).status,409);
  const fresh=await f.get('/api/folder?path='+folder.path);
  for(const [destination,status] of [['docs',409],['agents/source/child',400],['../outside',403]])assert.equal((await f.request('/api/folder',{action:'move',path:fresh.path,revision:fresh.revision,destination})).status,status);
  for(const name of ['AGENTS.md','script.js']){
    fs.writeFileSync(path.join(f.root,'agents/source',name),'protected');
    const state=await f.get('/api/folder?path=agents/source');
    assert.equal(state.mutable,false);
    assert.equal((await f.request('/api/folder',{action:'delete',path:state.path,revision:state.revision})).status,403);
    fs.unlinkSync(path.join(f.root,'agents/source',name));
  }
  assert.ok(fs.existsSync(path.join(f.root,'agents/source/note.md')));assert.equal(fs.existsSync(path.join(f.root,'docs/moved')),false);
});
test('symlink folders cannot be read, moved or used as destination',async t=>{
  const f=await fixture(t);fs.symlinkSync(path.join(f.root,'docs'),path.join(f.root,'alias'));
  assert.equal((await f.request('/api/folder?path=alias')).status,403);
  assert.equal((await f.request('/api/folder',{action:'create',path:'alias/new'})).status,403);
});
test('folder protection matches the document protection for mixed-case planner and review paths',async t=>{
  const f=await fixture(t);
  for(const [directory,name] of [['Planner','day.md'],['Reviews','agent-overview.md']]){
    fs.mkdirSync(path.join(f.root,directory));fs.writeFileSync(path.join(f.root,directory,name),'# Protected\n');
    assert.equal((await f.get('/api/document?path='+directory+'/'+name)).fileOperationsProtected,true);
    const state=await f.get('/api/folder?path='+directory);assert.equal(state.mutable,false);
    assert.equal((await f.request('/api/folder',{action:'delete',path:directory,revision:state.revision})).status,403);
    assert.ok(fs.existsSync(path.join(f.root,directory,name)));
  }
});
test('connected-project comments and folder moves stay in their project; cross-project moves are refused',async t=>{
  const f=await fixture(t),project=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-linked-'));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
  fs.mkdirSync(path.join(project,'docs'));fs.writeFileSync(path.join(project,'docs/note.md'),'# Project\n');
  const connected=await f.post('/api/connect-project',{name:'Demo',directory:project});const prefix='projects/'+connected.id+'/';
  const {saved}=await annotate(f,prefix+'docs/note.md');const folder=await f.get('/api/folder?path='+prefix+'docs');
  assert.equal((await f.request('/api/folder',{action:'move',path:folder.path,revision:folder.revision,destination:'docs/project'})).status,400);
  await f.post('/api/folder',{action:'move',path:folder.path,revision:folder.revision,destination:prefix+'renamed'});
  assert.deepEqual((await f.get('/api/annotations?path='+prefix+'renamed/note.md')).comments,saved.comments);
  assert.ok(fs.existsSync(path.join(project,'renamed/note.md')));
});
