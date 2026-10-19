import path from 'node:path';
import fs from 'node:fs';
import {initializeProject} from '../project-layout.mjs';
const root=path.resolve(process.argv[2]||'.');if(!fs.statSync(root).isDirectory())throw new Error('Expected an existing project directory');console.log(JSON.stringify({root,created:initializeProject(root)},null,2));
