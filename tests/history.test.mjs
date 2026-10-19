import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Store} from '../store.mjs';
const content='# Review\n\n| Theme | Agent comment | Letushv comment |\n|---|---|---|\n| R01 · Design | Original answer | мои слова |\n';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-history-'));fs.mkdirSync(path.join(root,'reviews'));fs.writeFileSync(path.join(root,'reviews/test.md'),content);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:new Store(root)};}
test('external agent change is versioned across instances, marked unseen, and reopens closed row',t=>{
 const {root,store}=fixture(t);let doc=store.read('reviews/test.md');store.rowState(doc.path,doc.revision,'R01','closed');
 fs.writeFileSync(path.join(root,doc.path),content.replace('Original answer','New answer'));
 doc=new Store(root).read(doc.path);assert.equal(doc.rows[0].updated,true);assert.equal(doc.rows[0].beforeAgent,'Original answer');assert.equal(doc.rows[0].status,'review');
 assert.ok(store.history(doc.path).some(v=>store.version(doc.path,v.id).content===content));
 store.rowState(doc.path,doc.revision,'R01','seen');assert.equal(new Store(root).read(doc.path).rows[0].updated,false);
});
test('agent-only restore keeps new user comment bytes and stale restores conflict',t=>{
 const {store}=fixture(t);let doc=store.read('reviews/test.md');const previous=store.history(doc.path)[0];
 doc=store.write(doc.path,doc.revision,content.replace('Original answer','New answer'));
 doc=store.comment(doc.path,doc.revision,[{id:'R01',comment:'  новое | решение\nдальше  '}]);const before=doc.content.split('\n')[4].split('|')[3];
 const restored=store.restoreVersion(doc.path,doc.revision,previous.id,'agent','R01');assert.equal(restored.rows[0].agent,'Original answer');assert.equal(restored.content.split('\n')[4].split('|')[3],before);
 assert.throws(()=>store.restoreVersion(doc.path,doc.revision,previous.id,'document'),e=>e.status===409);
 assert.throws(()=>store.version(doc.path,'../../escape'),e=>e.status===403);
});
test('agent updates preserve user bytes, append stable new IDs, and identify author',t=>{
 const {store}=fixture(t);const doc=store.read('reviews/test.md');const saved=store.agentReview(doc.path,doc.revision,[{id:'R01',agent:'Changed | answer'},{theme:'New issue',agent:'Proposal'}]);
 assert.equal(saved.content.split('\n')[4].split('|')[3],doc.content.split('\n')[4].split('|')[3]);assert.equal(saved.rows[1].id,'R02');assert.equal(saved.rows[1].comment,'');assert.equal(store.history(doc.path)[0].actor,'agent');
 assert.throws(()=>store.agentReview(doc.path,doc.revision,[{id:'R01',agent:'stale'}]),e=>e.status===409);
});
