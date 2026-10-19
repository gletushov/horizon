import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
export function findCodexBinary({env=process.env,home=os.homedir()}={}){
 if(env.HORIZON_CODEX_BIN)return env.HORIZON_CODEX_BIN;
 const candidates=[path.join(home,'.local/bin/codex'),...(env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,'codex')),
  '/opt/homebrew/bin/codex','/usr/local/bin/codex','/Applications/Codex.app/Contents/Resources/codex'];
 for(const candidate of candidates){try{if(fs.statSync(candidate).isFile()){fs.accessSync(candidate,fs.constants.X_OK);return candidate;}}catch{}}
 return 'codex';
}
