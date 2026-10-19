import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';

const source = '# Review\r\n\r\n| Theme | Agent comment | Letushv comment |\r\n|---|---|---|\r\n| R01 · Старт | Факт \\| источник |   мои  слова   |\r\n| R02 · Файлы | Предложение | ** |\r\n\r\nНе менять.\r\n';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-test-'));
  for (const dir of ['reviews', 'planner', 'research']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'reviews/test.md'), source);
  fs.writeFileSync(path.join(root, 'planner/day.md'), '# День\n\n- [ ] Задача\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {root, store: new Store(root)};
}
test('catalogue discovers Markdown, with actual review IDs and original comments', t => {
  const {store} = fixture(t);
  assert.equal(store.list().length, 2);
  const doc = store.read('reviews/test.md');
  assert.equal(doc.rows[0].id, 'R01');
  assert.equal(doc.rows[0].comment, 'мои  слова');
  assert.equal(doc.rows[1].comment, '');
});
test('batch comments persist through reopening; untouched bytes and backup survive', t => {
  const {root, store} = fixture(t);
  const before = store.read('reviews/test.md');
  const comment = '  мой комментарий | путь \\ файл\nещё <текст> & **  ';
  store.comment('reviews/test.md', before.revision, [{id: 'R02', comment}]);
  const reopened = new Store(root).read('reviews/test.md');
  assert.equal(reopened.rows[1].comment, comment);
  assert.equal(reopened.content.split('\r\n')[4], source.split('\r\n')[4]);
  assert.ok(reopened.content.endsWith('\r\n\r\nНе менять.\r\n'));
  const histories = fs.readdirSync(path.join(root, '.history'), {recursive:true}).filter(p=>p.endsWith('.md') && fs.statSync(path.join(root,'.history',p)).isFile());
  assert.ok(histories.some(p=>fs.readFileSync(path.join(root,'.history',p),'utf8')===source));
});
test('external edit rejects stale browser save and preserves external file', t => {
  const {root, store} = fixture(t);
  const before = store.read('reviews/test.md');
  const external = source.replace('Предложение', 'Новый ответ агента');
  fs.writeFileSync(path.join(root,'reviews/test.md'), external);
  assert.throws(()=>store.comment('reviews/test.md',before.revision,[{id:'R02',comment:'Да'}]), e=>e.status===409);
  assert.equal(fs.readFileSync(path.join(root,'reviews/test.md'),'utf8'),external);
});
test('invalid batch is all-or-nothing; duplicate IDs cannot misroute a comment', t => {
  const {root, store} = fixture(t);
  const before = store.read('reviews/test.md');
  assert.throws(()=>store.comment('reviews/test.md',before.revision,[{id:'R01',comment:'ok'},{id:'R99',comment:'oops'}]));
  assert.equal(fs.readFileSync(path.join(root,'reviews/test.md'),'utf8'),source);
  fs.writeFileSync(path.join(root,'reviews/test.md'),source.replace('R02','R01'));
  assert.throws(()=>store.comment('reviews/test.md',store.read('reviews/test.md').revision,[{id:'R01',comment:'no'}]));
});
test('all Markdown saves use revision checks', t => {
  const {root, store} = fixture(t);
  const before = store.read('planner/day.md');
  store.save('planner/day.md',before.revision,'# День\n\n- [x] Задача\n');
  assert.match(store.read('planner/day.md').content, /\[x\]/);
  assert.throws(()=>store.save('planner/day.md',before.revision,'stale'), e=>e.status===409);
  fs.writeFileSync(path.join(root,'research/note.md'),'Research');
  assert.equal(store.save('research/note.md',store.read('research/note.md').revision,'Edited').content,'Edited');
  assert.equal(store.save('reviews/test.md',store.read('reviews/test.md').revision,source+'New text').content,source+'New text');
});
test('paths and symlinks cannot escape the document roots', t => {
  const {root,store} = fixture(t);
  assert.equal(store.read('reviews/test.md').content, source);
  fs.writeFileSync(path.join(root,'private.md'),'private');
  fs.symlinkSync(path.join(root,'private.md'),path.join(root,'planner/link.md'));
  for (const p of ['../private.md','planner/../private.md','/etc/passwd','planner/link.md']) assert.throws(()=>store.read(p));
  assert.ok(!store.list().some(d=>d.path==='planner/link.md'));
});

test('create rename trash restore preserve content and reject overwrite',t=>{
  const {store}=fixture(t);const doc=store.create('notes/nested/test.md','# Note\n');
  assert.throws(()=>store.create(doc.path,'overwrite'),e=>e.status===409);
  const renamed=store.rename(doc.path,doc.revision,'notes/renamed.md');
  const removed=store.remove(renamed.path,renamed.revision);
  assert.throws(()=>store.read(renamed.path),e=>e.status===404);
  assert.equal(store.restore(removed.id).content,doc.content);
  assert.throws(()=>store.create('notes/../../escape.md','oops'),e=>e.status===403);
});
test('new review row preserves existing comments and task move preserves nested content',t=>{
  const {store}=fixture(t);let doc=store.read('reviews/test.md');
  const updated=store.addRow(doc.path,doc.revision,'Design','my | note');
  assert.equal(updated.rows.at(-1).comment,'my | note');
  assert.ok(updated.content.includes(doc.content.split('\n')[4]));
  const from=store.save('planner/day.md',store.read('planner/day.md').revision,'# Day\n- [ ] Parent\n  - [ ] Child\n\n- [ ] Keep\n');
  const to=store.create('planner/week.md','# Week\n- [ ] Other\n');
  store.moveTask(from.path,from.revision,1,to.path,to.revision,1);
  assert.match(store.read(to.path).content,/Parent\n  - \[ \] Child/);
  assert.doesNotMatch(store.read(from.path).content,/Parent|Child/);
  assert.throws(()=>store.moveTask(from.path,from.revision,1,to.path,to.revision),e=>e.status===409);
});
