#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkspaceStore} from '../workspace-store.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const usage='Usage: node scripts/agent-session.mjs register [--root PATH] [--project ID|local] --title TITLE [--summary TEXT] --provider codex|claude|zai|other [--session ID] [--task Tnn]';
const optionNames=new Set(['--root','--project','--title','--summary','--provider','--session','--task']);
const values={};
try {
  if(args.shift()!=='register')throw new Error(usage);
  for(let index=0;index<args.length;index++){
    const name=args[index];if(!optionNames.has(name)||index+1>=args.length||args[index+1].startsWith('--'))throw new Error(usage);
    values[name.slice(2)]=args[++index];
  }
  if(!values.title||!values.provider)throw new Error(usage);
  if(values.provider==='codex'){
    values.session??=process.env.CODEX_THREAD_ID;
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(values.session||''))throw new Error('Codex session ID required: run inside Codex (CODEX_THREAD_ID) or pass --session <thread ID>.');
  }
  const root=values.root?path.resolve(values.root):defaultRoot;
  const projectId=values.project===undefined||values.project==='local'||values.project==='null'?null:values.project;
  const result=new WorkspaceStore(root).registerAgentSession({
    projectId,
    taskTitle:values.title,
    ...(values.summary===undefined?{}:{summary:values.summary}),
    provider:values.provider,
    ...(values.session===undefined?{}:{sessionId:values.session}),
    ...(values.task===undefined?{}:{taskId:values.task})
  });
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  console.error(error.message);
  process.exitCode=error.status||1;
}
