import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-html-'));
  for(const dir of ['docs/assets','code','empty'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const html='<!doctype html><html><head><title>Мой отчёт</title><link rel="stylesheet" href="assets/theme.css"></head><body><h1>HTML со своей вёрсткой</h1><img src="assets/picture.svg"><script>parent.document.body.remove()</script></body></html>';
  fs.writeFileSync(path.join(root,'docs/report.html'),html);
  fs.writeFileSync(path.join(root,'docs/note.md'),'# Markdown\n');
  fs.writeFileSync(path.join(root,'docs/assets/theme.css'),'h1{color:rgb(120,20,60)}');
  fs.writeFileSync(path.join(root,'docs/assets/picture.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="10"/></svg>');
  fs.writeFileSync(path.join(root,'code/app.js'),'private code');
  fs.writeFileSync(path.join(root,'settings.json'),'private config');
  const app=createApp(root);await new Promise(r=>app.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+app.address().port;
  const request=(url,data)=>fetch(origin+url,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const json=async(url,data)=>{const response=await request(url,data);assert.equal(response.status,200,await response.clone().text());return response.json();};
  return {root,html,request,json};
}
test('the tree shows Markdown and HTML in local and connected projects, hides code-only folders and keeps user-created empty folders',async t=>{
  const f=await fixture(t);
  await f.json('/api/folder',{action:'create',path:'my-empty'});
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-html-project-'));t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
  fs.writeFileSync(path.join(project,'page.html'),'<title>Проект</title>');
  const connected=await f.json('/api/connect-project',{name:'Project',directory:project});
  const {documents}=await f.json('/api/documents');
  assert.deepEqual(documents.map(d=>d.path).sort(),['docs/note.md','docs/report.html',`projects/${connected.id}/page.html`].sort());
  assert.equal(documents.find(d=>d.path==='docs/report.html').title,'Мой отчёт');
  const projectPage=await f.request(`/document-preview/projects/${connected.id}/page.html`);assert.equal(projectPage.status,200);assert.equal(await projectPage.text(),'<title>Проект</title>');
  const {folders}=await f.json('/api/folders');
  assert.ok(folders.some(d=>d.path==='docs'));assert.ok(folders.some(d=>d.path==='my-empty'));
  assert.ok(!folders.some(d=>['code','empty','docs/assets'].includes(d.path)));
});
test('HTML opens read-only and survives file move, deletion and restore without becoming Markdown',async t=>{
  const f=await fixture(t),doc=await f.json('/api/document?path=docs/report.html');
  assert.equal(doc.format,'html');assert.equal(doc.editable,false);assert.equal(doc.content,f.html);assert.deepEqual(doc.rows,[]);
  const denied=await f.request('/api/document',{path:doc.path,revision:doc.revision,content:'# Accident'});assert.equal(denied.status,403);
  assert.equal(fs.readFileSync(path.join(f.root,doc.path),'utf8'),f.html);
  const moved=await f.json('/api/rename',{path:doc.path,revision:doc.revision,destination:'my-report.html'});
  const removed=await f.json('/api/delete',{path:moved.path,revision:moved.revision});
  const restored=await f.json('/api/restore',removed);assert.equal(restored.content,f.html);assert.equal(restored.format,'html');
  const conversion=await f.request('/api/rename',{path:restored.path,revision:restored.revision,destination:'converted.md'});assert.equal(conversion.status,400);
});
test('HTML preview keeps its source and relative styles and images, isolates scripts and refuses private files or symlinks',async t=>{
  const f=await fixture(t),preview=await f.request('/document-preview/docs/report.html');
  assert.equal(preview.status,200);assert.equal(await preview.text(),f.html);
  assert.match(preview.headers.get('content-type'),/^text\/html/);
  assert.match(preview.headers.get('content-security-policy'),/sandbox allow-same-origin;/);
  assert.match(preview.headers.get('content-security-policy'),/script-src 'none'/);
  assert.equal(await (await f.request('/document-preview/docs/assets/theme.css')).text(),'h1{color:rgb(120,20,60)}');
  assert.equal((await f.request('/document-preview/docs/assets/picture.svg')).status,200);
  for(const file of ['settings.json','code/app.js','docs/note.md','%2e%2e%2fsettings.json'])assert.equal((await f.request('/document-preview/'+file)).status,403);
  fs.symlinkSync(path.join(f.root,'docs/report.html'),path.join(f.root,'alias.html'));
  assert.equal((await f.request('/document-preview/alias.html')).status,403);
  assert.equal((await f.request('/api/document?path=alias.html')).status,403);
});
test('a folder of HTML and Markdown moves with its document history, while a folder containing code stays protected',async t=>{
  const f=await fixture(t);
  fs.mkdirSync(path.join(f.root,'pages'));fs.writeFileSync(path.join(f.root,'pages/page.html'),f.html);
  fs.writeFileSync(path.join(f.root,'pages/note.md'),'# Note\n');
  await f.json('/api/document?path=pages/page.html');
  const folder=await f.json('/api/folder?path=pages');assert.equal(folder.mutable,true);assert.equal(folder.documents.length,2);
  await f.json('/api/folder',{action:'move',path:'pages',revision:folder.revision,destination:'moved'});
  assert.equal((await f.json('/api/document?path=moved/page.html')).content,f.html);
  assert.ok((await f.json('/api/history?path=moved/page.html')).versions.length>0);
  const mixed=await f.json('/api/folder?path=code');assert.equal(mixed.mutable,false);
});
