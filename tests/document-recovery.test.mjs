import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const visual=fs.readFileSync(new URL('../public/visual.js',import.meta.url),'utf8');
test('network outage keeps latest typing and can save after reconnect',async()=>{
 let online=false,saved,stored;const timers=[];
 const ctx={draft:()=>null,keepDraft:(_key,data)=>stored=data,clearDraft(){},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},api:async(_url,data)=>{if(!online)throw Object.assign(Error('offline'),{network:true});saved=data.content;return {path:'note.md',revision:'b',content:saved};}};
 vm.createContext(ctx);vm.runInContext(visual.slice(visual.indexOf('function splitCells('),visual.indexOf('function sourcePieces('))+app.slice(app.indexOf('function mergeReviewDraft('),app.indexOf('async function reloadSourceEditor'))+';this.Session=DocumentSession;',ctx);
 const session=new ctx.Session({path:'note.md',revision:'a',content:'Old'});session.set('New');assert.equal(await session.flush(),false);assert.equal(stored.content,'New');session.set('New typing offline');online=true;await timers.at(-1)();assert.equal(saved,'New typing offline');assert.equal(session.error,null);
});
test('failed disk reload never clears the draft or active session',async()=>{
 for(const [source,name,end] of [[app,'reloadSourceEditor','function renderDocumentEditor'],[visual,'reloadVisual','function renderVisual']]){
 let cleared=0;const sessions=new Map([['note.md',{dirty:()=>true}]]);const ctx={documentSessions:sessions,$:()=>({}),read:async()=>{throw Error('offline');},clearTimeout(){},clearDraft:()=>cleared++,toast(){}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function '+name),source.indexOf(end)),ctx);await ctx[name]('note.md',...(name==='reloadSourceEditor'?['source',true]:[true]));assert.equal(cleared,0);assert.equal(sessions.size,1);
 }
});
