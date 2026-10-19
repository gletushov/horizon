import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const privateNames=new Set(['.horizon','.history','.runtime','.trash','.git','horizon.config.json','desktop.json','.env','letushv','notes','inbox','planner','reviews']);
const textTypes=new Set(['.mjs','.js','.cjs','.json','.html','.css','.md','.txt','.yml','.yaml','.plist','.svg','.map']);
const credentialPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/gh[pousr]_[A-Za-z0-9]{30,}/,/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{25,}/,/AKIA[0-9A-Z]{16}/];

export function auditRelease(directory){
 const root=path.resolve(directory),findings=[];
 const add=(kind,file)=>{if(!findings.some(f=>f.kind===kind&&f.file===file))findings.push({kind,file});};
 function walk(current){
  for(const entry of fs.readdirSync(current,{withFileTypes:true})){
   const full=path.join(current,entry.name),relative=path.relative(root,full);
   if(entry.isSymbolicLink()){add('symlink',relative);continue;}
   if(!relative.includes(path.sep)&&(privateNames.has(entry.name)||entry.name.startsWith('.env.'))){add('workspace-data',relative);continue;}
   if(entry.isDirectory()){walk(full);continue;}
   if(!textTypes.has(path.extname(entry.name)))continue;
   const source=fs.readFileSync(full,'utf8'),normalized=source.replaceAll('\\/','/');
   if(credentialPatterns.some(pattern=>pattern.test(source)))add('credential',relative);
   if(/\/Users\/letushv(?:\/|\b)/i.test(normalized))add('personal-path',relative);
   if(!relative.startsWith('node_modules'+path.sep)&&/Letushv|Horizon, Наука и Рэйти:/.test(source))add('personal-copy',relative);
  }
 }
 walk(root);return findings;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let directory=path.resolve(process.argv[2]||'.');
 if(directory.endsWith('.app'))directory=path.join(directory,'Contents/Resources/app');
 const findings=auditRelease(directory);
 console.log(JSON.stringify({directory,passed:findings.length===0,findings},null,2));
 if(findings.length)process.exitCode=1;
}
