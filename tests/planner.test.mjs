import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-planner-'));
  fs.mkdirSync(path.join(root,'planner'));
  fs.writeFileSync(path.join(root,'planner/day.md'),'# Day\n\n- [ ] Старый план\n');
  fs.writeFileSync(path.join(root,'planner/week.md'),'# Week\n\n- [ ] Parent\n  - [ ] Child\n  Старое описание\n\n- [ ] Keep\n');
  const server=createApp(root);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const request=async(url,body)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}${url}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
  const read=async p=>(await request('/api/document?path='+encodeURIComponent(p))).data;
  return {root,request,read};
}
test('task note, color and due date persist without changing siblings; stale edits reject',async t=>{
  const {request,read}=await fixture(t);const doc=await read('planner/week.md');
  const note='## Подробности\n\nПервый абзац\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- список\n  - вложенный\n\n```md\n- [ ] Это пример, не подзадача\n```';
  const saved=await request('/api/planner/task',{path:doc.path,revision:doc.revision,index:2,patch:{note,color:'blue',highlight:true,due:'2026-09-20'}});
  assert.equal(saved.status,200);assert.ok(saved.data.task.id);assert.equal(saved.data.task.note,note);assert.equal(saved.data.task.children.length,1);
  assert.equal(saved.data.task.color,'blue');assert.equal(saved.data.task.due,'2026-09-20');
  const fresh=await read(doc.path);assert.match(fresh.content,/- \[ \] Keep/);assert.match(fresh.content,/- \[ \] Child/);
  const changed=await request('/api/planner/task',{path:doc.path,revision:fresh.revision,id:saved.data.task.id,patch:{text:'Renamed'}});
  assert.equal(changed.status,200);assert.equal(changed.data.task.note,note);assert.equal(changed.data.task.id,saved.data.task.id);
  assert.equal((await request('/api/planner/task',{path:doc.path,revision:doc.revision,index:2,patch:{note:'stale'}})).status,409);
  assert.equal((await read(doc.path)).content,changed.data.document.content);
});
test('task and metadata travel to a dated day; deletion and undo restore the whole block',async t=>{
  const {request,read}=await fixture(t);let doc=await read('planner/week.md');
  const saved=await request('/api/planner/task',{path:doc.path,revision:doc.revision,index:2,patch:{note:'Keep me',color:'pink'}});assert.equal(saved.status,200);
  const day=await request('/api/planner/day',{date:'2026-09-17',revision:null,note:'My day'});assert.equal(day.status,200);
  doc=saved.data.document;
  const moved=await request('/api/move-task',{path:doc.path,revision:doc.revision,index:saved.data.task.index,destination:day.data.path,targetRevision:day.data.revision});assert.equal(moved.status,200);
  const target=await read(day.data.path);assert.match(target.content,/Keep me/);assert.match(target.content,/pink/);assert.match(target.content,/My day/);
  assert.doesNotMatch((await read(doc.path)).content,/Parent|Keep me/);
  const index=target.content.split('\n').findIndex(l=>l==='- [ ] Parent');
  const deleted=await request('/api/delete-task',{path:target.path,revision:target.revision,index});assert.equal(deleted.status,200);assert.doesNotMatch(deleted.data.content,/Parent|Keep me/);
  const restored=await request('/api/restore-version',{path:target.path,revision:deleted.data.revision,id:deleted.data.undoVersion,scope:'document'});assert.equal(restored.status,200);assert.equal(restored.data.content,target.content);
});
test('daily notes remain distinct; reading empty days does not create files or migrate legacy plans',async t=>{
  const {request,read,root}=await fixture(t);const legacy=(await read('planner/day.md')).content;
  const empty=await request('/api/planner/day?date=2026-09-17');assert.equal(empty.status,200);assert.equal(empty.data.revision,null);assert.equal(empty.data.note,'');assert.equal(fs.existsSync(path.join(root,'planner/days')),false);
  const a=await request('/api/planner/day',{date:'2026-09-17',revision:null,note:'Первый\n\n## Итог\nХорошо'});assert.equal(a.status,200);
  const b=await request('/api/planner/day',{date:'2026-09-18',revision:null,note:'Второй'});assert.equal(b.status,200);
  assert.equal((await request('/api/planner/day?date=2026-09-17')).data.note,'Первый\n\n## Итог\nХорошо');
  assert.equal((await request('/api/planner/day?date=2026-09-18')).data.note,'Второй');
  assert.equal((await read('planner/day.md')).content,legacy);
  assert.equal((await request('/api/planner/day',{date:'2026-09-17',revision:null,note:'overwrite'})).status,409);
  assert.equal((await request('/api/planner/day?date=2026-02-30')).status,400);
});
test('new day tasks and subtask edits preserve daily note and reject invalid metadata',async t=>{
  const {request,read}=await fixture(t);
  const added=await request('/api/planner/task',{path:'planner/days/2026-09-17.md',revision:null,action:'add',patch:{text:'New task'}});assert.equal(added.status,200);
  const child=await request('/api/planner/task',{path:added.data.document.path,revision:added.data.document.revision,id:added.data.task.id,patch:{addChild:'Child'}});assert.equal(child.status,200);
  const edited=await request('/api/planner/task',{path:child.data.document.path,revision:child.data.document.revision,id:child.data.task.id,childIndex:child.data.task.children[0].index,patch:{text:'Changed child',done:true,color:'yellow'}});assert.equal(edited.status,200);assert.equal(edited.data.task.children[0].text,'Changed child');assert.equal(edited.data.task.children[0].done,true);assert.equal(edited.data.task.children[0].color,'yellow');
  const note=await request('/api/planner/day',{date:'2026-09-17',revision:edited.data.document.revision,note:'Day context'});assert.equal(note.status,200);assert.match(note.data.content,/New task/);assert.match(note.data.content,/Changed child/);
  for(const patch of [{color:'red; evil'},{due:'2026-02-30'},{highlight:'yes'},{note:'x\n<!-- /horizon-note -->\ny'}]) {
    assert.equal((await request('/api/planner/task',{path:note.data.path,revision:note.data.revision,id:added.data.task.id,patch})).status,400);
  }
  assert.equal((await read(note.data.path)).content,note.data.content);
});

test('planner rejects structural metadata and unterminated task notes before editing',async t=>{
  const {request,read,root}=await fixture(t);
  const unsafe='# Week\n\n- [ ] Parent\n  <!-- horizon:{"id":"task-a","index":999,"text":"wrong"} -->\n  <!-- horizon-note -->\n  This note never closes.\n\n- [ ] Keep\n';
  fs.writeFileSync(path.join(root,'planner/week.md'),unsafe);
  const before=await read('planner/week.md');
  const response=await request('/api/planner/task',{path:before.path,revision:before.revision,index:2,patch:{color:'blue'}});
  assert.equal(response.status,409);
  assert.equal((await read(before.path)).content,unsafe);
});
