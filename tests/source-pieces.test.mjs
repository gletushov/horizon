import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {marked} from 'marked';
const source=fs.readFileSync(new URL('../public/visual.js',import.meta.url),'utf8');
const context=vm.createContext({marked});
vm.runInContext(source.slice(source.indexOf('function sourcePieces('),source.indexOf('function writable(')),context);
for(const separator of ['\n','\r\n','\r'])test('every block survives formatting and reload with '+JSON.stringify(separator)+' line endings',()=>{
  const content='# Заголовок'+separator+separator+'\n## Alpha **beta** gamma.\n\nUntouched  spaces.'+separator+separator+'- one'+separator+'- two'+separator;
  const pieces=context.sourcePieces(content);
  assert.deepEqual(Array.from(pieces.filter(p=>p.token&&p.token.type!=='space'),p=>p.token.type),['heading','heading','paragraph','list'],'paragraphs must remain visible after saving a formatted block');
  assert.equal(pieces.map(p=>p.raw).join(''),content,'source bytes, including all original whitespace, must be retained');
});
