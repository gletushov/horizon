import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.mjs';

const plannerFiles = ['day', 'week', 'month', 'quarter', 'year', 'future', 'life']
  .map(name => `planner/${name}.md`);
const protectedFiles = [
  'AGENTS.md', 'CLAUDE.md', 'SKILL.md',
  'nested/AGENTS.md', 'nested/CLAUDE.md', 'nested/SKILL.md',
  'skills/table-review/SKILL.md', 'reviews/agent-overview.md',
  ...plannerFiles
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-protection-'));
  for (const directory of ['nested', 'skills/table-review', 'reviews', 'planner', 'docs', 'notes']) {
    fs.mkdirSync(path.join(root, directory), {recursive: true});
  }
  for (const relative of protectedFiles) fs.writeFileSync(path.join(root, relative), `# ${relative}\n`);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, store: new Store(root)};
}

test('required system Markdown cannot be removed or renamed', t => {
  for (const relative of protectedFiles) {
    const {root, store} = fixture(t);
    const before = store.read(relative);
    assert.equal(before.fileOperationsProtected, true, relative);
    assert.throws(() => store.remove(relative, before.revision), error => error.status === 400, relative);
    assert.equal(store.read(relative).content, before.content, relative);
    assert.throws(() => store.rename(relative, before.revision, 'notes/renamed.md'), error => error.status === 400, relative);
    assert.equal(store.read(relative).content, before.content, relative);
    assert.equal(fs.existsSync(path.join(root, 'notes/renamed.md')), false, relative);
  }
});

test('rename refuses a protected destination before creating or overwriting it', t => {
  const {root, store} = fixture(t);
  const source = store.create('notes/source.md', '# Source\n');
  assert.equal(source.fileOperationsProtected, false);
  assert.throws(() => store.rename(source.path, source.revision, 'skills/new/skill.md'), error => error.status === 400);
  assert.equal(fs.existsSync(path.join(root, 'skills/new')), false);
  assert.throws(() => store.rename(source.path, source.revision, 'skills/new/SKILL.md'), error => error.status === 400);
  assert.equal(store.read(source.path).content, source.content);
  assert.equal(fs.existsSync(path.join(root, 'skills/new')), false);

  fs.writeFileSync(path.join(root, 'docs/AGENTS.md'), '# Existing system file\n');
  assert.throws(() => store.rename(source.path, source.revision, 'docs/AGENTS.md'), error => error.status === 400);
  assert.equal(fs.readFileSync(path.join(root, 'docs/AGENTS.md'), 'utf8'), '# Existing system file\n');

  fs.writeFileSync(path.join(root, 'docs/existing.md'), '# Existing\n');
  assert.throws(() => store.rename(source.path, source.revision, 'docs/existing.md'), error => error.status === 409);
  assert.equal(fs.readFileSync(path.join(root, 'docs/existing.md'), 'utf8'), '# Existing\n');

  const ordinary = store.create('docs/note.md', '# Note\n');
  const renamed = store.rename(ordinary.path, ordinary.revision, 'docs/renamed.md');
  assert.equal(renamed.content, '# Note\n');
});

test('protected checks follow a case alias to a required document', t => {
  const {root, store} = fixture(t);
  const alias = path.join(root, 'agents.md');
  if (!fs.existsSync(alias)) fs.linkSync(path.join(root, 'AGENTS.md'), alias);
  const doc = store.read('agents.md');
  assert.equal(doc.fileOperationsProtected, true);
  assert.throws(() => store.remove(doc.path, doc.revision), error => error.status === 400);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), true);
});
