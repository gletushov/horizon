import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WorkspaceStore} from '../workspace-store.mjs';
import {prepareDispatch} from '../agent-dispatch.mjs';

const thread='11111111-1111-4111-8111-111111111111';
const explicit='22222222-2222-4222-8222-222222222222';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-autolink-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'reviews'));
 fs.writeFileSync(path.join(root,'reviews/agent-overview.md'),'# Tasks\n\n| Task / session | Summary / purpose | Latest updates / next action | Letushv comments and decisions |\n|---|---|---|---|\n');
 const store=new WorkspaceStore(root);
 const task=store.registerAgentSession({projectId:null,provider:'codex',taskTitle:'Existing task'});
 const doc=store.local.read(task.docPath);
 fs.writeFileSync(path.join(root,task.docPath),doc.content.split('\n').map(line=>line.startsWith(`| ${task.taskId} `)?line.replace(/\|[^|]*\|\s*$/, '| Please continue |'):line).join('\n'));
 const run=(envId,args=[])=>spawnSync(process.execPath,['scripts/agent-session.mjs','register','--root',root,'--provider','codex','--title','Existing task','--task',task.taskId,...args],{encoding:'utf8',env:{...process.env,CODEX_THREAD_ID:envId}});
 return {root,store,task,run};
}
test('registration links the executing Codex session and makes the existing comment dispatchable',t=>{
 const {store,task,run}=fixture(t);
 const comment=store.read(task.docPath).rows[0].comment;
 assert.equal(comment,'Please continue');
 for(let i=0;i<2;i++){
  const result=run(thread);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionId,thread);
 }
 const doc=store.read(task.docPath);
 assert.equal(doc.rows.length,1);assert.equal(doc.rows[0].comment,comment);
 assert.deepEqual(doc.rows[0].overviewSessions,[{provider:'codex',sessionId:thread}]);
 const dispatch=prepareDispatch(store,{getRecord:()=>null},[task.taskId])[0];
 assert.equal(dispatch.error,undefined);assert.equal(dispatch.threadId,thread);
 assert.match(dispatch.prompt,/Please continue/);
});
test('explicit session wins; missing or invalid automatic IDs cannot silently register',t=>{
 const {store,task,run}=fixture(t);
 for(const invalid of ['', 'not-a-session']){
  const result=run(invalid);assert.notEqual(result.status,0);
  assert.deepEqual(store.read(task.docPath).rows[0].overviewSessions,[]);
 }
 const result=run(thread,['--session',explicit]);assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(result.stdout).sessionId,explicit);
});
