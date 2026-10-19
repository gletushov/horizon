import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {WorkspaceStore} from '../workspace-store.mjs';
import {readNotes,actNotes} from '../daily-work-store.mjs';
import {initializeProject} from '../project-layout.mjs';
import {auditRelease} from '../scripts/audit-release.mjs';

function root(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-privacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }

test('the planner uses the Mac timezone rather than the authors timezone',t=>{
 const directory=root(t);
 const program=`import './public/planner-core.js';import {readDay} from './planner-store.mjs';import {Store} from './store.mjs';console.log(JSON.stringify({today:HorizonPlanner.today(new Date('2026-01-01T00:30:00Z')),zone:readDay(new Store(${JSON.stringify(directory)}),'2026-01-01').timeZone}));`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',env:{...process.env,TZ:'America/Los_Angeles'}}));
 assert.deepEqual(result,{today:'2025-12-31',zone:'America/Los_Angeles'});
});

test('a new workspace stores notes in a neutral notes folder',t=>{
 const directory=root(t),store=new WorkspaceStore(directory),before=readNotes(store);
 assert.equal(before.path,'notes/continuous-note.md');
 const saved=actNotes(store,{action:'add',revision:before.revision,id:randomUUID(),text:'My own note'});
 assert.equal(saved.path,'notes/continuous-note.md');
 assert.match(fs.readFileSync(path.join(directory,saved.path),'utf8'),/My own note/);
 assert.equal(fs.existsSync(path.join(directory,'letushv')),false);
});

test('existing notes stay at their old path and keep their original text',t=>{
 const directory=root(t),legacy='letushv/continuous-note.md';
 fs.mkdirSync(path.join(directory,'letushv'));fs.writeFileSync(path.join(directory,legacy),'# Заметки\n\nKeep existing content.\n');
 const store=new WorkspaceStore(directory),before=readNotes(store);
 assert.equal(before.path,legacy);assert.match(before.legacy,/Keep existing content/);
 actNotes(store,{action:'add',revision:before.revision,id:randomUUID(),text:'New entry'});
 assert.match(fs.readFileSync(path.join(directory,legacy),'utf8'),/Keep existing content/);
 assert.equal(fs.existsSync(path.join(directory,'notes/continuous-note.md')),false);
});

test('new connected projects are initialized without the authors personal folder',t=>{
 const directory=root(t);initializeProject(directory);
 assert.ok(fs.existsSync(path.join(directory,'notes/inbox.md')));
 assert.equal(fs.existsSync(path.join(directory,'letushv')),false);
});

test('quick capture uses a neutral inbox on a new workspace',t=>{
 const directory=root(t),store=new WorkspaceStore(directory);
 assert.equal(store.review.note({text:'A quick thought'}).path,'notes/inbox.md');
 assert.equal(fs.existsSync(path.join(directory,'letushv')),false);
});

test('release audit catches private files, escaped home paths and credentials without returning their contents',t=>{
 const directory=root(t);fs.mkdirSync(path.join(directory,'.horizon'));fs.writeFileSync(path.join(directory,'.horizon/state.json'),'{}');
 fs.writeFileSync(path.join(directory,'horizon.config.json'),'{"projects":[]}');
 fs.writeFileSync(path.join(directory,'app.js'),'const home=/^\\/Users\\/letushv\\/Projects/; const key="'+'ghp_'+'a'.repeat(36)+'";');
 fs.writeFileSync(path.join(directory,'view.js'),"const column={label:'Letushv comment'};");
 const findings=auditRelease(directory);
 assert.ok(findings.some(f=>f.kind==='workspace-data'&&f.file==='horizon.config.json'));
 assert.ok(findings.some(f=>f.kind==='workspace-data'&&f.file.startsWith('.horizon')));
 assert.ok(findings.some(f=>f.kind==='personal-path'));
 assert.ok(findings.some(f=>f.kind==='credential'));
 assert.ok(findings.some(f=>f.kind==='personal-copy'&&f.file==='view.js'));
 assert.equal(JSON.stringify(findings).includes('a'.repeat(36)),false,'never print a credential in the report');
});

test('release audit allows public author metadata and a documented legacy directory identifier',t=>{
 const directory=root(t);
 fs.writeFileSync(path.join(directory,'package.json'),'{"author":"gletushov","repository":"https://github.com/gletushov/horizon"}');
 fs.writeFileSync(path.join(directory,'notes.mjs'),'const legacyDirectory="letushv";');
 assert.deepEqual(auditRelease(directory),[]);
});
