import fs from 'node:fs';
import path from 'node:path';

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2'};
export function documentPreview(workspace,relative) {
  const type=types[path.extname(relative)];
  const deny=()=>{throw Object.assign(new Error('Недоступный ресурс документа'),{status:403});};
  if(!type||relative.includes('\\')||relative.split('/').some(p=>!p||p.startsWith('.')))deny();
  const target=workspace.target(relative),directory=path.posix.dirname(target.relative);
  const file=path.join(target.store.resolveDirectory(directory==='.'?'':directory),path.posix.basename(target.relative));
  if(!fs.existsSync(file))throw Object.assign(new Error('Ресурс не найден'),{status:404});
  if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())deny();
  if(fs.statSync(file).size>10_000_000)throw Object.assign(new Error('Ресурс больше 10 МБ'),{status:413});
  return {type,content:fs.readFileSync(file)};
}
