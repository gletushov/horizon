let workspaceFolders=[];
const documentFolderName=value=>({agents:'Agents',letushv:'Letushv'})[value]||value;
const documentDisplayName=path=>path.split('/').at(-1).replace(/\.md$/i,'');
const documentMetadata=doc=>documentDisplayName(doc.path)+(doc.modifiedAt?' · '+new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(doc.modifiedAt)).replace(/ г\.$/,''):'');
const treeIcon=name=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${({file:'<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',folder:'<path d="M3 6h7l2 3h9v11H3z"/>',rename:'<path d="m15 4 5 5-11 11H4v-5zM13 6l5 5"/>',move:'<path d="M3 6h7l2 3h9v11H3zM8 14h9m-3-3 3 3-3 3"/>',delete:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',plus:'<path d="M12 4v16M4 12h16"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'})[name]||''}</svg>`;
const folderParent=value=>value.split('/').slice(0,-1).join('/');
const projectPrefix=value=>value.startsWith('projects/')?value.split('/').slice(0,2).join('/')+'/':'';
function treeMessage(text,undo) {
  toast(text);if(!undo)return;clearTimeout(toastTimer);
  const button=document.createElement('button');button.className='text-button';button.textContent='Отменить';$('#toast').append(' ',button);
  button.onclick=async()=>{button.disabled=true;try{await undo();$('#toast').hidden=true;}catch(e){button.disabled=false;toast(e.message);}};
}
async function flushTreePaths(prefix) {
  for(const [key,session] of documentSessions)if(key===prefix||key.startsWith(prefix+'/')){if(!await session.flush())throw Error('Сначала сохраните черновик или разрешите конфликт.');}
}
function rebaseTreePaths(from,to) {
  const map=HorizonEditor.remapPath;openDocumentTabs.remap(from,to);persistDocumentTabs();
  for(const [key,session] of [...documentSessions])if(map(key,from,to)!==key){
    const next=map(key,from,to);clearDraft(session.draftPath());documentSessions.delete(key);session.doc={...session.doc,path:next};if(session.dirty()){documentSessions.set(next,session);session.stash();}
  }
  for(const key of ['horizon:last-doc','horizon:last-doc:'+(activeDoc?.projectId||'local')]){const value=localStorage.getItem(key);if(value)localStorage.setItem(key,map(value,from,to));}
  for(const item of catalogue){const next=map(item.path,from,to);if(next===item.path)continue;const view=savedDocumentView(item.path);if(view){documentViewMemory.delete(item.path);documentViewMemory.set(next,view);try{localStorage.removeItem('horizon:view:'+item.path);localStorage.setItem('horizon:view:'+next,JSON.stringify(view));}catch{}}const note=draft('annotation:'+item.path);if(note){clearDraft('annotation:'+item.path);keepDraft('annotation:'+next,note);}}
  for(const [key,value] of [...documentScrollPositions]){const [view,encoded]=key.split('?'),p=decodeURIComponent(encoded||'');if(map(p,from,to)!==p){documentScrollPositions.set(view+'?'+encodeURIComponent(map(p,from,to)),value);documentScrollPositions.delete(key);}}
  if(activeDoc){const next=map(activeDoc.path,from,to);if(next!==activeDoc.path){activeDoc={...activeDoc,path:next};history.replaceState(history.state,'',location.pathname+'#docs?'+encodeURIComponent(next));visibleRouteHash=location.hash;}}
}
async function refreshDocumentTree() {await refreshCatalogue();workspaceFolders=(await api('/api/folders')).folders;main.drawDocumentTree?.($('#search')?.value||'');}
async function moveTreeItem(item,destination,undo=true) {
  if(item.path===destination)return;
  const oldPath=activeDoc?.path;rememberDocumentView();await flushTreePaths(item.path);
  if(item.kind==='folder') {const current=await api('/api/folder?path='+encodeURIComponent(item.path));await api('/api/folder',{action:'move',path:item.path,revision:current.revision,destination});}
  else {const current=await settled(item.path);await api('/api/rename',{path:item.path,revision:current.revision,destination});}
  rebaseTreePaths(item.path,destination);await refreshDocumentTree();
  if(oldPath!==activeDoc?.path){const current=await read(activeDoc.path);renderVisual(documentSessions.get(current.path)?.doc||current);restoreDocumentView();}
  treeMessage('«'+item.path.split('/').at(-1)+'» перемещён',undo?()=>moveTreeItem({...item,path:destination},item.path,false):null);
}
function folderOptions(item) {
  const prefix=projectPrefix(item.path),root=prefix.replace(/\/$/,'');
  return workspaceFolders.filter(f=>projectPrefix(f.path)===prefix&&f.path!==item.path&&!f.path.startsWith(item.path+'/')).map(f=>({value:f.path.replace(/\/$/,''),label:f.path===root?'Корень проекта':f.path.slice(prefix.length)||'Корень проекта'}));
}
function moveTreePanel(item) {
  const options=folderOptions(item);
  formInline('Переместить '+(item.kind==='folder'?'папку':'документ'),'<label class="form-field">Папка<select name="destination">'+options.map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')+'</select></label>',async data=>{const parent=data.get('destination');await moveTreeItem(item,(parent?parent+'/':'')+item.path.split('/').at(-1));},'Переместить','Имя сохраняется. Существующие файлы не перезаписываются.',$('.sidebar'));
}
function newTreeItem(parent,kind) {
  formInline(kind==='folder'?'Новая папка':'Новый документ',field('name','Название'),async data=>{
    let name=String(data.get('name')||'').trim();if(!name||name.includes('/')||name.includes('\\')||name.startsWith('.'))throw Error('Укажите название без слешей и начальной точки.');
    if(kind==='folder'){await api('/api/folder',{action:'create',path:(parent?parent+'/':'')+name});await refreshDocumentTree();}
    else {name=name.replace(/\.md$/i,'');const created=await api('/api/create',{path:(parent?parent+'/':'')+name+'.md',content:'# '+name+'\n'});await refreshDocumentTree();location.hash='#docs?'+encodeURIComponent(created.path);}
  },'Создать','',$('.sidebar'));
}
function renameTreeItem(item) {
  const extension=item.path.endsWith('.html')?'.html':'.md';
  formInline('Переименовать '+(item.kind==='folder'?'папку':'документ'),field('name','Новое название',item.kind==='folder'?item.path.split('/').at(-1):item.path.split('/').at(-1).replace(/\.(md|html)$/i,'')),async data=>{
    let name=String(data.get('name')||'').trim();if(!name||name.includes('/')||name.includes('\\')||name.startsWith('.'))throw Error('Укажите название без слешей и начальной точки.');
    if(item.kind!=='folder')name=name.replace(/\.(md|html)$/i,'')+extension;const parent=folderParent(item.path);await moveTreeItem(item,(parent?parent+'/':'')+name);
  },'Переименовать','',$('.sidebar'));
}
async function deleteTreeItem(item) {
  formInline('Удалить '+(item.kind==='folder'?'папку с документами':'документ')+'?',`<p>${esc(item.path)}</p>`,async()=>{
    await flushTreePaths(item.path);let result;
    if(item.kind==='folder'){const current=await api('/api/folder?path='+encodeURIComponent(item.path));result=await api('/api/folder',{action:'delete',path:item.path,revision:current.revision});}
    else {const current=await settled(item.path);result=await api('/api/delete',{path:item.path,revision:current.revision});}
    localStorage.setItem('horizon:last-trash',JSON.stringify(result));openDocumentTabs.paths=openDocumentTabs.paths.filter(p=>p!==item.path&&!p.startsWith(item.path+'/'));persistDocumentTabs();
    const deletedActive=activeDoc&&(activeDoc.path===item.path||activeDoc.path.startsWith(item.path+'/'));
    if(deletedActive){for(const [key]of [...documentSessions])if(key===item.path||key.startsWith(item.path+'/'))documentSessions.delete(key);localStorage.removeItem('horizon:last-doc');activeDoc=null;await refreshCatalogue();workspaceFolders=(await api('/api/folders')).folders;const next=catalogue.find(d=>d.path!=='reviews/agent-overview.md');history.replaceState(history.state,'',location.pathname+'#docs'+(next?'?'+encodeURIComponent(next.path):''));await renderRoute();}
    else {await refreshDocumentTree();if(activeDoc)renderDocumentTabs($('.document-main'),activeDoc);}
    treeMessage('«'+item.path.split('/').at(-1)+'» удалён',()=>restoreTreeItem(result));showRestore();
  },'Удалить','Можно вернуть через «Отменить».',$('.sidebar'));
}
async function restoreTreeItem(item) {
  const result=await api(item.kind==='folder'?'/api/folder':'/api/restore',item.kind==='folder'?{...item,action:'restore'}:item);
  localStorage.removeItem('horizon:last-trash');await refreshDocumentTree();showRestore();
  if(item.kind!=='folder')location.hash='#docs?'+encodeURIComponent(result.path);toast('Восстановлено');
}
async function treeContextMenu(event,item) {
  event.preventDefault();event.stopPropagation?.();document.querySelector('.document-context-menu')?.remove();
  const trigger=event.currentTarget,menu=document.createElement('div');menu.className='document-context-menu';menu.setAttribute('role','menu');
  const actions=item.kind==='folder'?[['new-file','plus','Новый документ'],['new-folder','folder','Новая папка'],['rename','rename','Переименовать'],['move','move','Переместить…'],['delete','delete','Удалить']]:[['open','file','Открыть'],['copy','copy','Скопировать ссылку'],['rename','rename','Переименовать'],['move','move','Переместить…'],['delete','delete','Удалить']];
  if(item.kind==='folder'&&(!item.path||/^projects\/[^/]+$/.test(item.path))){actions.push(['import','file','Добавить Markdown-файлы'],['refresh','folder','Обновить дерево'],['system','file','Служебные файлы'],['connect','plus','Подключить проект']);}
  menu.innerHTML=actions.map(([id,icon,label])=>`<button role="menuitem" data-action="${id}">${treeIcon(icon)}<span>${label}</span></button>`).join('');
  const rect=trigger?.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(event.clientX||rect?.left||8,innerWidth-225))+'px';menu.style.top=Math.max(8,Math.min(event.clientY||rect?.bottom||8,innerHeight-actions.length*42-20))+'px';document.body.append(menu);
  const close=()=>{menu.remove();document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keys);};
  const outside=e=>{if(!menu.contains(e.target))close();};
  const keys=e=>{if(e.key==='Escape'){close();trigger?.focus();}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keys);
  for(const button of menu.querySelectorAll('button'))button.onclick=async()=>{close();try{
    const action=button.dataset.action;if(action==='open')location.hash='#docs?'+encodeURIComponent(item.path);
    else if(action==='copy'){const url=new URL(location.href);url.search='';url.hash='#docs?'+encodeURIComponent(item.path);await navigator.clipboard.writeText(url.href);toast('Ссылка скопирована');}
    else if(action==='new-file'||action==='new-folder')newTreeItem(item.path,action==='new-file'?'file':'folder');
    else if(action==='import')openImportPanel({path:(item.path?item.path+'/':'')+'note.md'});else if(action==='refresh')await refreshDocumentTree();else if(action==='connect')$('#connect-project').click();else if(action==='system'){const control=$('.system-toggle input');control.checked=!control.checked;control.dispatchEvent(new Event('change'));}
    else if(action==='rename')renameTreeItem(item);else if(action==='move')moveTreePanel(item);else if(action==='delete')deleteTreeItem(item);
  }catch(e){toast(e.message);}};
  for(const action of ['rename','move','delete'])menu.querySelector('[data-action='+action+']').disabled=true;
  try{const mutable=item.kind==='folder'?(await api('/api/folder?path='+encodeURIComponent(item.path))).mutable:!(await read(item.path)).fileOperationsProtected;if(!menu.isConnected)return;for(const action of ['rename','move','delete'])menu.querySelector('[data-action='+action+']').disabled=!mutable;menu.querySelector('button:not(:disabled)')?.focus();}catch(e){close();toast(e.message);}
}
function bindTreeRow(row,item) {
  row.oncontextmenu=e=>treeContextMenu(e,item);
  const more=document.createElement('button');more.className='tree-more';more.textContent='⋯';more.setAttribute('aria-label','Действия: '+(item.path.split('/').at(-1)||'Horizon'));more.onclick=e=>treeContextMenu(e,item);row.append(more);
  row.onkeydown=e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10')treeContextMenu(e,item);};
  const handle=row.querySelector('.document-link')||row;handle.draggable=Boolean(item.path)&&!/^projects\/[^/]+$/.test(item.path);
  handle.ondragstart=e=>{e.stopPropagation();e.dataTransfer.setData('application/x-horizon-file',JSON.stringify(item));e.dataTransfer.effectAllowed='move';document.body.classList.add('tree-dragging');};
  handle.ondragend=()=>{document.body.classList.remove('tree-dragging');document.querySelectorAll('.tree-drop').forEach(n=>n.classList.remove('tree-drop'));};
}
function bindTreeDrop(element,folderPath) {
  element.ondragover=e=>{if(!e.dataTransfer.types.includes('application/x-horizon-file')||e.target.closest('details.tree-folder')!==element)return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';element.querySelector(':scope > summary').classList.add('tree-drop');element.open=true;};
  element.ondragleave=e=>{if(!element.contains(e.relatedTarget))element.querySelector(':scope > summary').classList.remove('tree-drop');};
  element.ondrop=async e=>{if(e.target.closest('details.tree-folder')!==element)return;e.preventDefault();e.stopPropagation();element.querySelector(':scope > summary').classList.remove('tree-drop');try{const item=JSON.parse(e.dataTransfer.getData('application/x-horizon-file'));if(projectPrefix(item.path)!==projectPrefix(folderPath))throw Error('Перенос доступен внутри проекта.');await moveTreeItem(item,(folderPath?folderPath+'/':'')+item.path.split('/').at(-1));}catch(error){toast(error.message);}finally{document.body.classList.remove('tree-dragging');}};
}
async function renderDocuments(view,path,version) {
  workspaceFolders=(await api('/api/folders')).folders;if(version!==routeVersion)return;
  const emptyTabs=!path&&localStorage.getItem('horizon:open-documents')==='[]';
  const selected=emptyTabs?null:(path?(catalogue.find(d=>d.path===path)||{path}):null)||catalogue.find(d=>d.path===localStorage.getItem('horizon:last-doc'))||catalogue.find(d=>d.path!=='reviews/agent-overview.md');
  let loaded=null,missing=false;try{loaded=selected?await read(selected.path):null;}catch(error){if(error.status===404)missing=true;else throw error;}if(version!==routeVersion)return;
  main.dataset.documentView=view;
  main.innerHTML='<div class="documents-layout"><aside class="sidebar"><div class="sidebar-actions"><strong>Документы</strong><button class="icon-button" id="new-document" aria-label="Создать документ">＋</button><button class="icon-button" id="import-documents" hidden aria-label="Добавить Markdown-файлы">⇧</button><button class="icon-button" id="refresh-documents" hidden aria-label="Обновить дерево">↻</button></div><input id="search" class="search" type="search" aria-label="Поиск документов" placeholder="Найти документ…"><div id="doc-list"></div><label class="system-toggle" hidden><input type="checkbox"> Служебные файлы</label><button class="connect-project" id="connect-project" hidden>＋ Подключить проект</button></aside><div class="tree-resizer" role="separator" aria-label="Ширина дерева" aria-orientation="vertical" tabindex="0"></div><section class="document-main"></section></div>';
  let showSystem=localStorage.getItem('horizon:show-system')==='true';
  const draw=query=>{
    $('#doc-list').replaceChildren();const search=query.toLowerCase(),current=activeDoc?.path||loaded?.path;
    for(const project of projectRoots){
      const prefix=project.prefix||'',rootPath=prefix.replace(/\/$/,''),root={path:rootPath,children:new Map(),files:[]};
      const addFolder=relative=>{let node=root;for(const part of relative.split('/').filter(Boolean)){if(!node.children.has(part))node.children.set(part,{path:(node.path?node.path+'/':'')+part,children:new Map(),files:[]});node=node.children.get(part);}return node;};
      const documents=catalogue.filter(d=>d.projectId===project.id&&(view!=='inbox'||/(^|\/)(letushv|inbox)\//.test(d.path)));
      for(const f of workspaceFolders.filter(f=>f.projectId===project.id))if(!search)addFolder(f.path.slice(prefix.length));
      for(const doc of documents){const relative=doc.path.slice(prefix.length),system=/(^|\/)(AGENTS\.md|CLAUDE\.md|SKILL\.md|skills|tests|\.agents)(\/|$)/i.test(relative);if(!showSystem&&system)continue;if(!(doc.title+' '+doc.path).toLowerCase().includes(search))continue;addFolder(folderParent(relative)).files.push(doc);}
      const drawFolder=(node,parent,name,isRoot=false)=>{
        const details=document.createElement('details');details.className='tree-folder'+(isRoot?' tree-project':'');details.dataset.folder=node.path;details.open=isRoot||Boolean(search)||current?.startsWith(node.path+'/')||localStorage.getItem('horizon:group:'+node.path)==='open';
        const summary=document.createElement('summary');const label=document.createElement('span');label.className='tree-label';label.innerHTML=(isRoot?'':'<svg class="folder-chevron" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="m2.5 1.5 2.5 2.5-2.5 2.5" stroke="currentColor" stroke-width="1"/></svg>')+'<span>'+esc(name)+'</span>';summary.append(label);bindTreeRow(summary,{path:node.path,kind:'folder'});details.append(summary);bindTreeDrop(details,node.path);parent.append(details);
        const children=document.createElement('div');children.className='tree-children';details.append(children);
        let drawn=false;const expand=()=>{if(!details.open||drawn)return;drawn=true;
        for(const [childName,child]of [...node.children].sort(([a],[b])=>{const order=['letushv','agents','docs'];const ai=order.indexOf(a),bi=order.indexOf(b);return (ai<0?99:ai)-(bi<0?99:bi)||a.localeCompare(b);}))drawFolder(child,children,documentFolderName(childName));
        for(const doc of node.files){const row=document.createElement('div');row.className='tree-row';const button=document.createElement('button');button.className='document-link'+(doc.path===current?' selected':'');button.dataset.path=doc.path;button.title=doc.path;button.innerHTML='<span>'+esc(documentDisplayName(doc.path))+'</span>';row.append(button);bindTreeRow(row,{path:doc.path,kind:'file'});button.onclick=()=>{rememberDocumentView();if(matchMedia('(max-width:650px)').matches)setTreeHidden(true);location.hash='#'+view+'?'+encodeURIComponent(doc.path);};children.append(row);}
        };expand();
        details.ontoggle=()=>{localStorage.setItem('horizon:group:'+node.path,details.open?'open':'closed');expand();};
      };drawFolder(root,$('#doc-list'),project.name,true);
    }
  };
  main.drawDocumentTree=draw;main.revealDocument=()=>draw($('#search').value);draw('');$('#search').oninput=e=>draw(e.target.value);
  const system=$('.system-toggle input');system.checked=showSystem;system.onchange=()=>{showSystem=system.checked;localStorage.setItem('horizon:show-system',String(showSystem));draw($('#search').value);};
  $('#new-document').onclick=()=>newTreeItem(activeDoc?folderParent(activeDoc.path):'', 'file');$('#import-documents').onclick=()=>openImportPanel(activeDoc);$('#refresh-documents').onclick=async()=>{try{await refreshDocumentTree();}catch(e){toast(e.message);}};
  $('#connect-project').onclick=()=>formInline('Подключить проект',field('name','Название проекта')+field('directory','Путь к папке'),async data=>{await api('/api/connect-project',{name:data.get('name'),directory:data.get('directory')});await refreshDocumentTree();},'Подключить','',$('.sidebar'));
  const resize=$('.tree-resizer'),setWidth=value=>{value=Math.max(190,Math.min(420,value));document.documentElement.style.setProperty('--tree-width',value+'px');localStorage.setItem('horizon:tree-width',value);resize.setAttribute('aria-valuenow',value);resize.setAttribute('aria-valuemin','190');resize.setAttribute('aria-valuemax','420');};setWidth(Number(localStorage.getItem('horizon:tree-width'))||224);
  resize.onpointerdown=e=>{resize.setPointerCapture(e.pointerId);resize.onpointermove=event=>setWidth(event.clientX);resize.onpointerup=()=>resize.onpointermove=null;};resize.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tree-width'))+(e.key==='ArrowRight'?16:-16));}};
  showRestore();if(searchRequested){searchRequested=false;setTreeHidden(false);$('#search').focus();}else if(matchMedia('(max-width:650px)').matches)setTreeHidden(true);
  if(missing){renderUnavailableDocument(selected.path);}else if(loaded){activeDoc=loaded;renderVisual(loaded);}else $('.document-main').innerHTML='<div class="empty-state"><h1>Открой документ</h1><p>Выбери файл в дереве или создай новый.</p></div>';
}
