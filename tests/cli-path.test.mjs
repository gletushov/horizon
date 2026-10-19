import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {findCodexBinary} from '../cli-path.mjs';
test('Codex installed on PATH works without the authors local wrapper',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-cli-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const bin=path.join(home,'bin');fs.mkdirSync(bin);const cli=path.join(bin,'codex');fs.writeFileSync(cli,'#!/bin/sh\nexit 0\n',{mode:0o700});
 assert.equal(findCodexBinary({env:{PATH:bin},home}),cli);
 fs.mkdirSync(path.join(home,'.local/bin'),{recursive:true});fs.writeFileSync(path.join(home,'.local/bin/codex'),'not executable',{mode:0o600});
 assert.equal(findCodexBinary({env:{PATH:bin},home}),cli);
});
test('an explicit Codex path is respected even when unavailable, without silently selecting a different agent',()=>{
 assert.equal(findCodexBinary({env:{HORIZON_CODEX_BIN:'/missing/chosen-codex',PATH:''},home:'/unused'}),'/missing/chosen-codex');
});
