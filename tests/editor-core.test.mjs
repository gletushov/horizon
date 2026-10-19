import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/editor-core.js',import.meta.url),'utf8'),context);
const {locateQuote,remapPath}=context.HorizonEditor;
test('a comment follows an unchanged quote when earlier text is inserted, including repeated quotes distinguished by context',()=>{
  const comment={quote:'same',prefix:'First ',suffix:' end',start:6};
  assert.deepEqual(JSON.parse(JSON.stringify(locateQuote('Intro First same end. Other same later.',comment))),{start:12,end:16});
  assert.equal(locateQuote('same and same',{quote:'same',start:0}),null);
  assert.equal(locateQuote('removed',{quote:'same',prefix:'First ',suffix:' end'}),null);
});
test('a moved folder rebases its open document and draft path, without moving similarly named siblings',()=>{
  assert.equal(remapPath('docs/a/note.md','docs/a','agents/b'),'agents/b/note.md');
  assert.equal(remapPath('docs/a.md','docs/a.md','agents/renamed.md'),'agents/renamed.md');
  assert.equal(remapPath('docs/another/note.md','docs/a','agents/b'),'docs/another/note.md');
});
