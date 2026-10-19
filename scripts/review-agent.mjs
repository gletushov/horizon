#!/usr/bin/env node
// JSON files keep quotes and user text out of shell interpolation.
import fs from 'node:fs';import path from 'node:path';import {WorkspaceStore} from '../workspace-store.mjs';
const [command,root,relative,changesFile]=process.argv.slice(2);
try {
 if(!['read','update'].includes(command)||!root||!relative)throw new Error('Usage: node scripts/review-agent.mjs read|update WORKSPACE_ROOT DOCUMENT_PATH [CHANGES.json]');
 const store=new WorkspaceStore(path.resolve(root));
 if(command==='read')console.log(JSON.stringify(store.read(relative),null,2));
 else {if(!changesFile)throw new Error('Укажите JSON-файл с revision и changes');const data=JSON.parse(fs.readFileSync(changesFile,'utf8'));const saved=store.agentReview(relative,data.revision,data.changes);console.log(JSON.stringify({path:saved.path,revision:saved.revision,reviewSchema:saved.reviewSchema,rows:saved.rows.map(r=>({id:r.id,parentId:r.parentId,commentVersion:r.commentVersion,currentAssignee:r.currentAssignee,task:r.task,taskTitle:r.taskTitle,theme:r.theme,summary:r.summary,updates:r.updates,agent:r.agent,comment:r.comment,userComment:r.userComment,status:r.status,updated:r.updated}))},null,2));}
}catch(error){console.error(error.message);process.exitCode=1;}
