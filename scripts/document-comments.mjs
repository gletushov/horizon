#!/usr/bin/env node
import {WorkspaceStore} from '../workspace-store.mjs';
const [root,relative]=process.argv.slice(2);
if(!root||!relative){console.error('Usage: node scripts/document-comments.mjs WORKSPACE_ROOT DOCUMENT_PATH');process.exitCode=1;}
else {try{console.log(new WorkspaceStore(root).exportAnnotations(relative).text);}catch(e){console.error(e.message);process.exitCode=1;}}
