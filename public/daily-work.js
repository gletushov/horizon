// Persistent open-file list; text and view recovery remain in the existing editor.
let storedTabs=[];try{storedTabs=JSON.parse(localStorage.getItem('horizon:open-documents')||'[]');}catch{}
const openDocumentTabs=HorizonEditor.tabs(storedTabs);
const persistDocumentTabs=()=>{try{localStorage.setItem('horizon:open-documents',JSON.stringify(openDocumentTabs.paths));}catch{toast('Не удалось сохранить список вкладок');}};
function documentRoute(path,heading=''){return '#docs?'+encodeURIComponent(path)+(heading?'&heading='+encodeURIComponent(heading):'');}
function headingIds(root){
 const counts=new Map();for(const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')){const slug=h.textContent.toLowerCase().trim().replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/\s+/g,'-')||'section';const n=counts.get(slug)||0;counts.set(slug,n+1);if(!h.id)h.id=slug+(n?'-'+n:'');}
}
function revealDocumentHeading(heading){if(!heading)return;requestAnimationFrame(()=>{const root=document.querySelector('.document-main');headingIds(root);const target=[...root.querySelectorAll('[id]')].find(n=>n.id===heading);if(target)target.scrollIntoView({block:'start'});else toast('Заголовок «'+heading+'» не найден');});}
function renderDocumentTabs(root,doc){
 openDocumentTabs.open(doc.path);persistDocumentTabs();root.querySelector('.document-tabs')?.remove();
 const name=path=>{const base=path.split('/').at(-1).replace(/\.md$/i,'');const duplicate=openDocumentTabs.paths.filter(p=>p.split('/').at(-1)===path.split('/').at(-1)).length>1;return base+(duplicate?' · '+(path.split('/').at(-2)||'Horizon'):'');};
 const tabs=document.createElement('nav');tabs.className='document-tabs';tabs.setAttribute('aria-label','Открытые документы');
 const select=path=>{rememberDocumentView();location.hash=documentRoute(path);};
 const close=async path=>{
  const session=documentSessions.get(path);if(session&&!await session.flush()){
   const panel=HorizonDialogs.open('Не удалось сохранить изменения','<p>Вкладка остаётся открытой. Черновик сохранён в этом браузере.</p><p class="save-status" role="status"></p><div class="inline-actions"><button class="button" data-retry>Повторить сохранение</button><button class="button" data-close-draft>Закрыть с черновиком</button></div>');
   panel.querySelector('[data-retry]').onclick=async()=>{if(session.error?.status!==409)session.error=null;if(await session.flush()){panel.close();finish();}else panel.querySelector('[role=status]').textContent=session.error?.message||'Не сохранено';};
   panel.querySelector('[data-close-draft]').onclick=()=>{session.stash();panel.close();finish();};return;
  }finish();
  function finish(){rememberDocumentView();const next=openDocumentTabs.close(path);persistDocumentTabs();if(path===activeDoc?.path){if(next)location.hash=documentRoute(next);else{root.commentsCleanup?.();localStorage.removeItem('horizon:last-doc');history.replaceState(history.state,'',location.pathname+'#docs');visibleRouteHash=location.hash;activeDoc=null;root.innerHTML='<div class="empty-state"><h1>Открой документ</h1><p>Выбери файл в дереве слева.</p></div>';}}else if(root.isConnected&&activeDoc)renderDocumentTabs(root,activeDoc);}
 };
 for(const path of openDocumentTabs.paths){const box=document.createElement('span');box.className='document-tab'+(path===doc.path?' active':'');box.innerHTML='<button type="button" data-open-tab="'+esc(path)+'" title="'+esc(path)+'">'+esc(name(path))+'</button><button type="button" data-close-tab="'+esc(path)+'" aria-label="Закрыть '+esc(name(path))+'">×</button>';box.querySelector('[data-open-tab]').onclick=()=>select(path);box.querySelector('[data-close-tab]').onclick=()=>close(path);tabs.append(box);}
 const mobile=document.createElement('button');mobile.className='document-tabs-mobile';mobile.textContent=name(doc.path)+' · '+openDocumentTabs.paths.length+' открыто';mobile.onclick=()=>{
  const panel=HorizonDialogs.open('Открытые документы','<div class="open-document-list"></div>');
  for(const path of openDocumentTabs.paths){const row=document.createElement('div');row.innerHTML='<button class="open-file"><strong>'+esc(name(path))+'</strong><small>'+esc(path)+'</small></button><button class="icon-button" aria-label="Закрыть '+esc(name(path))+'">×</button>';row.querySelector('.open-file').onclick=()=>{panel.close();select(path);};row.querySelector('.icon-button').onclick=()=>{panel.close();close(path);};panel.querySelector('.open-document-list').append(row);}
 };tabs.append(mobile);const mobileHead=root.querySelector('.document-mobile-head');if(mobileHead)mobileHead.after(tabs);else root.prepend(tabs);tabs.querySelector('.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function renderUnavailableDocument(path){
 const root=document.querySelector('.document-main');if(!root)return;
 root.commentsCleanup?.();activeDoc={path,title:documentDisplayName(path),projectName:catalogue.find(d=>d.path===path)?.projectName||'Horizon'};
 root.innerHTML='<div class="empty-state"><h1>Файл недоступен</h1><p>'+esc(path)+'</p><p>Файл удалён или перемещён вне Horizon. Можно закрыть вкладку и открыть его по новому пути.</p></div>';
 const saved=documentSessions.get(path)?.value??draft('source:'+path)?.content;
 if(saved){const box=document.createElement('section');box.innerHTML='<h2>Сохранённый черновик</h2><textarea class="missing-document-draft" aria-label="Черновик недоступного документа" readonly></textarea><button class="button" type="button">Скопировать черновик</button>';box.querySelector('textarea').value=saved;box.querySelector('button').onclick=async()=>{try{await navigator.clipboard.writeText(saved);toast('Черновик скопирован');}catch{box.querySelector('textarea').select();toast('Выдели текст и скопируй вручную');}};root.append(box);}
 renderDocumentTabs(root,activeDoc);
}
function imageURL(current,source){
 if(/^data:image\/(png|jpeg|gif|webp);/i.test(source)||/^https?:\/\//i.test(source)||source.startsWith('/document-preview/'))return source;
 const target=HorizonEditor.documentLink(current,source);return target?'/document-preview/'+target.path.split('/').map(encodeURIComponent).join('/'):'';
}
function prepareDocumentImages(root,current){
 headingIds(root);for(const img of root.querySelectorAll('img')){const source=img.dataset.originalSrc||img.getAttribute('src');if(!source)continue;img.dataset.originalSrc=source;img.src=imageURL(current,source);img.title='Открыть изображение';img.tabIndex=0;img.onerror=()=>{img.alt=(img.alt||'Изображение')+' — не удалось загрузить';};img.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();showDocumentImage(img);}};}
}
function showDocumentImage(img){const panel=HorizonDialogs.open(img.alt||'Изображение','<img class="full-image" alt="">',{className:'image-viewer'});const big=panel.querySelector('img');big.src=img.src;big.alt=img.alt;big.onerror=()=>{const p=document.createElement('p');p.textContent='Не удалось загрузить изображение';panel.append(p);};}
document.addEventListener('click',event=>{const img=event.target.closest('.markdown img,.review-answer img,.continuous-note-content img');if(img){event.preventDefault();event.stopImmediatePropagation();showDocumentImage(img);}},true);
function selectedEditor(){const node=getSelection()?.anchorNode;return (node?.nodeType===1?node:node?.parentElement)?.closest('[contenteditable="true"]');}
async function insertDocumentImages(element,files,current){
 const range=getSelection()?.rangeCount&&element.contains(getSelection().anchorNode)?getSelection().getRangeAt(0).cloneRange():null;
 for(const file of files){
  try{
   if(file.size>10000000)throw Error('Изображение больше 10 МБ');
   const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать изображение'));reader.readAsDataURL(file);});
   const saved=await api('/api/images',{path:current,name:file.name,data});
   if(!element.isConnected){toast('Изображение сохранено. Вернись к документу и вставь: '+saved.markdown);return;}
   element.focus({preventScroll:true});const selection=getSelection();selection.removeAllRanges();if(range&&range.startContainer.isConnected)selection.addRange(range);else{const end=document.createRange();end.selectNodeContents(element);end.collapse(false);selection.addRange(end);}
   const src=saved.markdown.match(/\(<([^>]+)>\)/)[1];document.execCommand('insertHTML',false,'<img src="'+esc(src)+'" data-original-src="'+esc(src)+'" alt="'+esc(file.name.replace(/\.[^.]+$/,''))+'">');prepareDocumentImages(element,current);element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));
  }catch(error){toast(error.message);}
 }
}
function mountImageInsertion(element,current){
 element.dataset.imageDocument=current;
 element.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();element.classList.add('image-drop-target');}});
 element.addEventListener('dragleave',()=>element.classList.remove('image-drop-target'));
 element.addEventListener('drop',e=>{const files=[...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'));if(!files.length)return;e.preventDefault();element.classList.remove('image-drop-target');const range=document.caretRangeFromPoint?.(e.clientX,e.clientY);if(range&&element.contains(range.startContainer)){const sel=getSelection();sel.removeAllRanges();sel.addRange(range);}insertDocumentImages(element,files,current);});
 prepareDocumentImages(element,current);
}
function imagePicker(element,current){const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/gif,image/webp';input.multiple=true;input.onchange=()=>insertDocumentImages(element,[...input.files],current);input.click();}

function noteStamp(value){const date=new Date(value);return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(date).replace(/ г\.$/,'')+' · '+new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit'}).format(date);}
async function renderContinuousNote(version){
 const data=await api('/api/notes');if(version!==routeVersion)return;
 delete main.dataset.documentView;activeDoc=null;main.classList.add('notes-host');
 main.innerHTML='<section class="continuous-note"><div class="document-mobile-head"><span></span><strong>Horizon</strong><details class="mobile-document-navigation"><summary aria-label="Разделы Horizon">⋯</summary><nav><a href="#inbox">Заметки</a><a href="#agents">Агенты</a><a href="#docs">Документы</a></nav></details></div><h1>Заметки</h1><p class="document-meta">Одна заметка · <span data-note-status role="status">сохранено</span></p><form class="note-capture"><label class="sr-only" for="note-capture">Записать мысль</label><textarea id="note-capture" placeholder="Записать мысль…" rows="3"></textarea><div><span class="muted">⌘Enter · новая запись с датой</span><span class="note-capture-buttons"><button class="button" type="button" data-note-image aria-label="Вставить изображение в заметку"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-5 5 6"/></svg><span class="image-label">Изображение</span></button><button type="submit" class="button primary">Добавить</button></span></div></form><div class="continuous-note-entries"></div><details class="previous-notes"><summary>Прежние заметки и файлы</summary><div></div></details></section>';
 const root=main.querySelector('.continuous-note'),input=root.querySelector('textarea'),message=root.querySelector('[data-note-status]'),button=root.querySelector('[type=submit]');let state=data,pending=null;
 const key='continuous-note:capture',recovered=draft(key);input.value=recovered?.content||'';pending=recovered?.id?{id:recovered.id,text:input.value}:null;
 input.oninput=()=>{if(pending&&pending.text!==input.value)pending=null;keepDraft(key,{content:input.value,...(pending?{id:pending.id}:{})});button.disabled=!input.value.trim();};button.disabled=!input.value.trim();
 const draw=()=>{
  const list=root.querySelector('.continuous-note-entries');list.replaceChildren();
  for(const entry of state.entries){const article=document.createElement('article');article.className='continuous-note-entry';article.dataset.noteId=entry.id;article.innerHTML='<header><time>'+esc(noteStamp(entry.createdAt))+'</time><button class="icon-button" aria-label="Действия записи">⋯</button></header><div class="continuous-note-content markdown">'+md(entry.text)+'</div>';prepareDocumentImages(article,state.path);article.querySelector('button').onclick=()=>noteActions(entry,article);list.append(article);}
  if(state.legacy){const old=document.createElement('section');old.className='continuous-note-content markdown';old.innerHTML=md(state.legacy);prepareDocumentImages(old,state.path);list.append(old);}
 };
 async function linkNote(entry,label,url){
  const fresh=await api('/api/notes'),current=fresh.entries.find(e=>e.id===entry.id);if(!current)throw Error('Исходная запись не найдена');
  const link='['+label+']('+url+')';state=current.text.includes(link)?fresh:await api('/api/notes',{action:'edit',revision:fresh.revision,id:entry.id,text:current.text+'\n\n'+link});draw();
 }
 async function noteActions(entry,article){
  const panel=HorizonDialogs.open('Запись от '+new Date(entry.createdAt).toLocaleString('ru-RU',{}),'<div class="note-actions"><button class="button" data-edit>Редактировать</button><button class="button" data-copy>Скопировать</button><button class="button" data-document>Сохранить как документ</button><button class="button" data-task>Создать задачу</button></div><p role="status"></p>');
  panel.querySelector('[data-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(entry.text);panel.querySelector('[role=status]').textContent='Скопировано';}catch(e){panel.querySelector('[role=status]').textContent=e.message;}};
  panel.querySelector('[data-edit]').onclick=()=>{panel.close();const content=article.querySelector('.continuous-note-content'),original=entry.text,stash=draft('note-edit:'+entry.id);content.innerHTML=md(stash?.content??original);mountImageInsertion(content,state.path);let value=stash?.content??original;HorizonRichText.mount(content,'Текст записи',text=>{value=text;keepDraft('note-edit:'+entry.id,{content:text});},()=>{});const actions=document.createElement('div');actions.className='inline-actions';actions.innerHTML='<button class="button" data-cancel>Отмена</button><button class="button primary" data-save>Сохранить</button><span role="status"></span>';article.append(actions);actions.querySelector('[data-cancel]').onclick=()=>{clearDraft('note-edit:'+entry.id);draw();};actions.querySelector('[data-save]').onclick=async()=>{try{state=await api('/api/notes',{action:'edit',revision:state.revision,id:entry.id,text:value});clearDraft('note-edit:'+entry.id);draw();}catch(e){actions.querySelector('[role=status]').textContent=e.message;}};content.focus();};
  panel.querySelector('[data-document]').onclick=()=>{panel.close();let created=null;formInline('Сохранить как документ',field('path','Путь',state.path.slice(0,state.path.lastIndexOf('/')+1)+'thought-'+entry.id.slice(0,8)+'.md'),async fields=>{
   created||=await api('/api/create',{path:fields.get('path'),sourcePath:state.path,content:entry.text+'\n'});
   try{await linkNote(entry,'Документ',documentRoute(created.path));toast('Документ создан; исходная запись сохранена');}
   catch(error){throw Error('Документ создан: '+created.path+'. Ссылка не сохранена: '+error.message+'. Повтори для добавления ссылки.');}
  },'Создать');};
  panel.querySelector('[data-task]').onclick=()=>{panel.close();let created=null;formInline('Создать задачу',field('title','Название',entry.text.split('\n')[0].slice(0,1000))+'<label class="form-field">Проект<select name="project">'+projectRoots.map(p=>'<option value="'+esc(p.id||'')+'">'+esc(p.name)+'</option>').join('')+'</select></label>',async fields=>{
   if(!created){const fresh=await api('/api/review');created=await api('/api/review',{action:'create',revision:fresh.revision,title:fields.get('title'),projectId:fields.get('project')||null,comment:entry.text});}
   try{await linkNote(entry,'Задача '+created.createdId,'#agents');toast('Задача создана; агент ещё не запущен');}
   catch(error){throw Error('Задача '+created.createdId+' создана. Ссылка не сохранена: '+error.message+'. Повтори для добавления ссылки.');}
  },'Создать');};
 }
 root.querySelector('form').onsubmit=async e=>{e.preventDefault();if(button.disabled||!input.value.trim())return;const text=input.value;pending=pending?.text===text?pending:{id:crypto.randomUUID(),text};keepDraft(key,{content:text,id:pending.id});button.disabled=true;message.textContent='Сохраняется…';try{state=await api('/api/notes',{action:'add',revision:state.revision,...pending});if(input.value===text){input.value='';pending=null;clearDraft(key);}draw();message.textContent='Сохранено';input.focus();}catch(error){message.textContent=error.message;state=await api('/api/notes').catch(()=>state);}finally{button.disabled=!input.value.trim();}};
 async function captureImages(files){const initial=input.value,start=input.selectionStart,end=input.selectionEnd;let markdown='';for(const file of files){try{if(file.size>10000000)throw Error('Изображение больше 10 МБ');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать изображение'));reader.readAsDataURL(file);});markdown+='\n'+(await api('/api/images',{path:state.path,name:file.name,data})).markdown+'\n';}catch(e){message.textContent=e.message;}}if(markdown&&input.isConnected){input.setRangeText(markdown,input.value===initial?start:input.value.length,input.value===initial?end:input.value.length,'end');input.oninput();input.focus();}}
 root.querySelector('[data-note-image]').onclick=()=>{const picker=document.createElement('input');picker.type='file';picker.accept='image/png,image/jpeg,image/gif,image/webp';picker.multiple=true;picker.onchange=()=>captureImages([...picker.files]);picker.click();};
 input.addEventListener('paste',e=>{const files=[...e.clipboardData.files].filter(f=>f.type.startsWith('image/'));if(files.length){e.preventDefault();captureImages(files);}});
 input.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});input.addEventListener('drop',e=>{const files=[...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'));if(files.length){e.preventDefault();captureImages(files);}});
 input.onkeydown=e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();root.querySelector('form').requestSubmit();}};
 for(const doc of catalogue.filter(d=>/(^|\/)(notes|letushv|inbox)\//.test(d.path)&&d.path!==state.path)){const link=document.createElement('a');link.href=documentRoute(doc.path);link.textContent=(doc.projectName||'Horizon')+' / '+doc.title;root.querySelector('.previous-notes div').append(link);}
 draw();
}
