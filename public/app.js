const $ = selector => document.querySelector(selector);
const main = $('#main');
let projectRoots = [], catalogue = [], boardDocs = [], activeDoc = null, routeVersion = 0;
let searchRequested = false;
const documentScrollPositions = new Map();
let visibleRouteHash = null;
let toastTimer, draggedTask = null, horizonEditor = null, horizonTaskUndo = null, agentSessionResult = null;

const periods = [
  ['day', 'Day', 'Today', 'What matters today?'],
  ['week', 'Week', 'This week', 'What deserves a place this week?'],
  ['month', 'Month', 'This month', 'What result matters this month?'],
  ['quarter', 'Quarter', 'This quarter', 'What could change in three months?'],
  ['year', 'Year', String(new Date().getFullYear()), 'What should be true by year end?'],
  ['future', '3 years', 'Further out', 'What needs time and attention?'],
  ['life', 'Life', 'No deadline', 'What remains important?']
];
let reviewCleanup=null;
const sectionLabels = {agents:'Agents',inbox: 'Inbox', horizons: 'Horizons', docs: 'Docs', money: 'Money', health: 'Health', people: 'People', ease: 'Ease', universe: 'Universe'};

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const md = text => DOMPurify.sanitize(marked.parse(String(text ?? '')), {FORBID_TAGS:['style','form','input','textarea','button','iframe'], FORBID_ATTR:['style']});
function toast(text) {
  const target = $('#toast');
  if (!target) return;
  target.textContent = text;
  target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 4200);
}
async function api(endpoint, data) {
  let response; try { response = await fetch(endpoint, data ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)} : {}); } catch { throw Object.assign(new Error('Сервер недоступен. Черновик сохранён; подключение будет повторено.'), {network:true}); }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Не удалось сохранить'), {status:response.status});
  return result;
}
const read = path => api('/api/document?path=' + encodeURIComponent(path));
const draftKey = path => 'horizon:draft:' + path;
function draft(path) { try { return JSON.parse(localStorage.getItem(draftKey(path))); } catch { return null; } }
function keepDraft(path, data) { try { localStorage.setItem(draftKey(path), JSON.stringify(data)); return true; } catch { toast('Не удалось сохранить черновик в браузере. Сохраните изменения в файл.'); return false; } }
function clearDraft(path) { localStorage.removeItem(draftKey(path)); }
function status(element, text, error = false) { if (!element) return; element.textContent = text; element.classList.toggle('error', error); }

function normalizeView(view) {
  if (view === 'reviews' || view === 'documents') return 'docs';
  return sectionLabels[view] ? view : 'agents';
}
function setActiveNavigation(view) {
  document.querySelectorAll('[data-nav]').forEach(link => {
    const overview = !location.hash || location.hash.startsWith('#agents') || location.hash.includes('reviews%2Fagent-overview.md');
    const active = link.dataset.nav === 'agents' ? overview : link.dataset.nav === view && !overview;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
}
function currentPeriod(key) {
  const now = new Date();
  const month = now.toLocaleDateString('en-US', {month:'long'});
  return ({day:now.toLocaleDateString('en-US', {day:'numeric', month:'short'}), week:'This week', month, quarter:'Q' + (Math.floor(now.getMonth() / 3) + 1), year:String(now.getFullYear()), future:`${now.getFullYear()}–${now.getFullYear() + 3}`, life:'No deadline'})[key];
}
async function refreshCatalogue() {
  const result = await api('/api/documents');
  catalogue = result.documents;
  projectRoots = result.projects;
}
async function renderRoute() {
  if(location.hash==='#docs'){const last=localStorage.getItem('horizon:last-doc');if(last)history.replaceState(history.state,'',location.pathname+'#docs?'+encodeURIComponent(last));}
  if (activePlannerEditor && !await activePlannerEditor.flush()) return;
  rememberDocumentView();
  const incomingHash = location.hash;
  if (visibleRouteHash !== null) documentScrollPositions.set(visibleRouteHash, window.scrollY);
  const version = ++routeVersion;
  document.querySelectorAll('dialog[open]').forEach(panel => panel.close());
  const [rawView, fullEncoded = ''] = location.hash.slice(1).split('?');
  const [encoded, heading='']=fullEncoded.split('&heading=');main.classList.remove('notes-host');
  const view = rawView==='docs'&&decodeURIComponent(encoded)==='reviews/agent-overview.md'?'agents':normalizeView(rawView || 'agents');
  if(reviewCleanup){reviewCleanup();reviewCleanup=null;}
  setActiveNavigation(view); $('#toggle-tree').hidden = view === 'agents' || view === 'horizons' || (view === 'inbox' && !encoded);
  main.setAttribute('aria-busy', 'true');
  try {
    if(view==='agents'){document.querySelector('.document-main')?.commentsCleanup?.();delete main.dataset.documentView;activeDoc=null;reviewCleanup=await HorizonReview.mount(main,{api,esc,md,toast});return;}
    let path = decodeURIComponent(encoded);
    if(view==='docs'&&!path)path=localStorage.getItem('horizon:last-doc')||'';
    if(view==='docs'&&path!=='reviews/agent-overview.md'){localStorage.setItem('horizon:last-doc',path);const project=catalogue.find(d=>d.path===path)?.projectId||'local';localStorage.setItem('horizon:last-doc:'+project,path);}
    if (main.dataset.documentView === view && path && path !== activeDoc?.path && catalogue.some(doc => doc.path === path) && $('.document-main')) {
      const previous = documentSessions.get(activeDoc?.path);
      if (previous && !await previous.flush()) { toast('Изменения не сохранены. Черновик останется в этом браузере.'); }
      const nextDoc = await read(path);
      if (version !== routeVersion) return;
      activeDoc = nextDoc; if(nextDoc.path!=='reviews/agent-overview.md')localStorage.setItem('horizon:last-doc:'+(nextDoc.projectId||'local'),nextDoc.path); renderVisual(nextDoc);if(matchMedia('(max-width:650px)').matches)setTreeHidden(true); main.revealDocument?.(path);
      document.querySelectorAll('.document-link').forEach(button => button.classList.toggle('selected', button.dataset.path === path));
      $('#new-document').onclick = () => newTreeItem(folderParent(nextDoc.path),'file');
      $('#import-documents').onclick = () => openImportPanel(nextDoc);
      return;
    }
    await refreshCatalogue();
    if (version !== routeVersion) return;
    if (view === 'horizons') await renderBoard(version);
    else if (view === 'inbox' && !encoded) await renderContinuousNote(version);
    else await renderDocuments(view, path, version);
  } catch (error) {
    if (version !== routeVersion) return;
    if(view==='docs'&&error.status===404&&encoded&&$('.document-main')){renderUnavailableDocument(decodeURIComponent(encoded));return;}
    if ($('.document-main') || $('.board')) { toast(error.message); return; }
    main.innerHTML = `<div class="empty-state"><span class="eyebrow">${esc(sectionLabels[view] || 'Horizon')}</span><h1>Не удалось открыть файлы</h1><p>${esc(error.message)}</p><button class="button" id="retry">Повторить</button></div>`;
    $('#retry').onclick = renderRoute;
  } finally { if (version === routeVersion) { main.removeAttribute('aria-busy'); if (visibleRouteHash !== incomingHash) window.scrollTo({top:documentScrollPositions.get(incomingHash) || savedDocumentView(activeDoc?.path)?.y || 0}); restoreDocumentView(); revealDocumentHeading(decodeURIComponent(heading)); visibleRouteHash = incomingHash; await revealInboxResult(); } }
}

const planner = HorizonPlanner;
let selectedDay = planner.today(), legacyDay = false, expandedTask = null;
let activePlannerEditor = null, focusedHorizon = localStorage.getItem('horizon:focused-column');
const plannerWrites = new Map();
let showCompleted = localStorage.getItem('horizon:show-completed') !== 'false';
let plannerBusy = false;
const plannerDraftKey = (doc,task,kind) => `planner:${doc.path}:${task?.id || (task ? 'line-'+task.index : 'day')}:${kind}`;
const taskRef = task => task.id ? {id:task.id} : {index:task.index};
document.addEventListener('click',event=>{if(activePlannerEditor&&!activePlannerEditor.card.contains(event.target))activePlannerEditor.flush();});

async function renderBoard(version) {
  const requestedColumn=new URLSearchParams(location.hash.split('?')[1]||'').get('column');
  if(periods.some(([key])=>key===requestedColumn))focusedHorizon=requestedColumn;
  const day = legacyDay ? await read('planner/day.md') : await api('/api/planner/day?date='+selectedDay);
  boardDocs = [day, ...await Promise.all(periods.slice(1).map(([key])=>read(`planner/${key}.md`)))];
  if(version !== routeVersion)return;
  const previousScroll = $('.board')?.scrollLeft ?? Number(localStorage.getItem('horizon:scroll')||0);
  delete main.dataset.documentView;
  main.innerHTML = `<section class="board-shell"><div class="planner-toolbar"><button class="text-button" id="app-back" aria-label="Назад">← Назад</button><label class="completed-toggle"><input type="checkbox" id="show-completed" ${showCompleted?'checked':''}> Выполненные</label><div class="board-navigation"><button class="icon-button" id="board-left" aria-label="Предыдущие горизонты">←</button><button class="icon-button" id="board-right" aria-label="Следующие горизонты">→</button></div></div><div id="planner-message" role="status"></div><div id="horizon-editor-slot"></div><div class="board" aria-label="Horizons"></div></section>`;
  $('#app-back').disabled=navigationIndex===0;$('#app-back').onclick=()=>history.back();
  $('#show-completed').onchange=event=>{showCompleted=event.target.checked;localStorage.setItem('horizon:show-completed',String(showCompleted));renderRoute();};
  $('#board-left').onclick=()=>$('.board').scrollBy({left:-400,behavior:'smooth'});
  $('#board-right').onclick=()=>$('.board').scrollBy({left:400,behavior:'smooth'});
  const renderedTasks = new Map();
  let suppressTaskClickUntil=0;
  const clearDrop=()=>document.querySelectorAll('.drop-before,.drop-after,.drop-column').forEach(node=>node.classList.remove('drop-before','drop-after','drop-column'));
  const stopDrag=()=>{draggedTask=null;clearDrop();document.querySelectorAll('.task-dragging').forEach(node=>node.classList.remove('task-dragging'));suppressTaskClickUntil=Date.now()+250;};
  const focusColumn = key => {focusedHorizon=key;localStorage.setItem('horizon:focused-column',key||'');document.querySelectorAll('.horizon-column').forEach(node=>{const selected=node.dataset.horizon===key;node.classList.toggle('expanded-column',selected);node.querySelector('.column-heading')?.setAttribute('aria-pressed',String(selected));});};
  const mutate = (doc,task,patch,extra={}) => {
    const operation=async()=>{
      const result=await api('/api/planner/task',{path:doc.path,revision:doc.revision,...(task?taskRef(task):{action:'add'}),patch,...extra,revision:typeof extra.revision==='function'?extra.revision():extra.revision??doc.revision});
      const previousRevision=doc.revision;Object.assign(doc,result.document);activePlannerEditor?.rebase?.(doc.path,previousRevision,doc.revision);
      const fresh=planner.tasks(doc.content);
      (renderedTasks.get(doc.path)||[]).forEach((item,index)=>{const next=item.id?fresh.find(t=>t.id===item.id):fresh[index];if(next){const children=next.children.map((child,i)=>Object.assign(item.children.find(c=>child.id&&c.id===child.id)||item.children[i]||{},child));Object.assign(item,next,{children});}});
      return result;
    };
    const pending=(plannerWrites.get(doc.path)||Promise.resolve()).catch(()=>{}).then(operation);
    plannerWrites.set(doc.path,pending);pending.finally(()=>{if(plannerWrites.get(doc.path)===pending)plannerWrites.delete(doc.path);}).catch(()=>{});
    return pending;
  };
  const act = fn => async event => {event?.preventDefault();try{if(activePlannerEditor&&!await activePlannerEditor.flush())return;await fn();}catch(error){toast(error.message);}};
  const redraw = async () => {await renderRoute();};
  const ensureDestination = async doc => doc.revision===null ? api('/api/planner/day',{date:doc.date,revision:null,note:''}) : doc;
  const move = async (doc,task,destination,before=null) => {
    if(plannerBusy)throw new Error('Дождитесь сохранения.');
    plannerBusy=true;
    try {
      await Promise.all([plannerWrites.get(doc.path),plannerWrites.get(destination.path)]);
      const anchor=(renderedTasks.get(destination.path)||[]).find(t=>t.index===before);
      if(!task.id)await mutate(doc,task,{});
      const target=await ensureDestination(destination);before=anchor?.index??before;
      await api('/api/move-task',{path:doc.path,revision:doc.revision,...taskRef(task),destination:target.path,targetRevision:target.revision,before,beforeId:anchor?.id||undefined});
    } catch(error){await redraw();throw new Error(error.message+' Списки перечитаны; проверьте положение задачи перед повтором.');}
    finally {plannerBusy=false;}
    expandedTask=null;await redraw();toast('Задача перенесена вместе с заметкой');
  };
  if(horizonTaskUndo) {
    const state=horizonTaskUndo,box=$('#planner-message');
    box.innerHTML='<div class="task-undo-notice">Задача удалена вместе с заметкой и подзадачами. <button class="text-button">Отменить</button></div>';
    box.querySelector('button').onclick=act(async()=>{await api('/api/restore-version',{path:state.path,revision:state.revision,id:state.undoVersion,scope:'document'});horizonTaskUndo=null;await redraw();});
  }
  periods.forEach(([key,title,,empty],columnIndex)=>{
    const doc=boardDocs[columnIndex],items=planner.tasks(doc.content),column=document.createElement('section');column.className='horizon-column';column.dataset.plannerPath=doc.path;column.dataset.horizon=key;renderedTasks.set(doc.path,items);column.classList.toggle('expanded-column',focusedHorizon===key);column.tabIndex=0;column.setAttribute('aria-label',title+' горизонт');
    const today=planner.today();
    let period=currentPeriod(key);
    if(key==='day')period=legacyDay?'Общий план без даты':selectedDay;
    if(key==='week'){const dayOfWeek=new Date(today+'T12:00:00Z').getUTCDay();const monday=planner.shiftDate(today,-((dayOfWeek+6)%7));period=`${monday.slice(8)}–${planner.shiftDate(monday,6).slice(8)} ${new Date(monday+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',timeZone:'UTC'})}`;}
    column.innerHTML=`<div class="period">${esc(period)}</div><div class="column-title"><h2><button class="column-heading" aria-label="Фокус: ${title}" aria-pressed="${focusedHorizon===key}">${title}</button></h2><button class="icon-button collapse-horizon" aria-label="Свернуть ${title}">−</button></div><div class="column-tools"></div><div class="task-list"></div><form class="add-task"><span aria-hidden="true">＋</span><input aria-label="Новая задача: ${title}" placeholder="${['Focus…','Execute…','Achieve…','Build…','Reach…','Visualise…','Become…'][columnIndex]}" maxlength="1000" autocomplete="off"></form>`;
    column.querySelector('.column-heading').onclick=act(async()=>focusColumn(focusedHorizon===key?null:key));
    const sourceButton=document.createElement('button');sourceButton.className='icon-button horizon-source';sourceButton.textContent='⌘';sourceButton.setAttribute('aria-label','Открыть Markdown '+title);sourceButton.title='Открыть Markdown';sourceButton.onclick=act(async()=>doc.revision===null?toast('Сначала добавьте задачу'):openHorizonEditor(doc.path));column.querySelector('.column-title').append(sourceButton);
    const collapsed=localStorage.getItem('horizon:collapsed:'+key)==='true';
    const expand=document.createElement('button');expand.className='expand-horizon';expand.textContent=title+' ＋';expand.setAttribute('aria-label','Развернуть '+title);column.prepend(expand);column.classList.toggle('collapsed',collapsed);
    const collapse=value=>{column.classList.toggle('collapsed',value);localStorage.setItem('horizon:collapsed:'+key,String(value));};
    column.querySelector('.collapse-horizon').onclick=()=>collapse(true);expand.onclick=()=>collapse(false);
    column.onclick=event=>{if(event.target.closest('.task,button,input,textarea,select,a,form'))return;focusColumn(key);};
    column.onkeydown=event=>{if(event.target!==column||!['Enter',' '].includes(event.key))return;event.preventDefault();focusColumn(focusedHorizon===key?null:key);};
    const list=column.querySelector('.task-list');
    if(key==='day') {
      const tools=column.querySelector('.column-tools');tools.innerHTML=`<div class="day-navigation"><button class="icon-button" data-prev aria-label="Предыдущий день">‹</button><input type="date" aria-label="Дата плана" min="1900-01-01" max="9999-12-31" value="${selectedDay}"><button class="icon-button" data-next aria-label="Следующий день">›</button></div><div class="day-mode"><button class="text-button" data-today>Сегодня</button><button class="text-button" data-legacy>${legacyDay?'К дате':'Прежний план'}</button></div>`;
      const setDay=async value=>{if(!planner.dateValid(value)){toast('Выберите корректную дату');return;}selectedDay=value;legacyDay=false;expandedTask=null;await redraw();};
      tools.querySelector('[data-prev]').onclick=()=>setDay(planner.shiftDate(selectedDay,-1));tools.querySelector('[data-next]').onclick=()=>setDay(planner.shiftDate(selectedDay,1));tools.querySelector('input').onchange=event=>setDay(event.target.value);tools.querySelector('[data-today]').onclick=()=>setDay(planner.today());tools.querySelector('[data-legacy]').onclick=()=>{legacyDay=!legacyDay;redraw();};
      if(legacyDay){const hint=document.createElement('p');hint.className='legacy-plan-hint';hint.textContent='Прежний общий план. Перенос на дату доступен по клику на задачу.';tools.append(hint);}
    }
    if(!items.length&&key!=='day'){const copy=doc.content.split('\n').filter(line=>!/^#\s/.test(line)).join('\n').trim();if(copy){const note=document.createElement('div');note.className='column-note';note.innerHTML=md(copy);column.querySelector('.column-tools').append(note);}}
    const visible=items.filter(task=>showCompleted||!task.done);
    if(!visible.length&&!column.querySelector('.column-note')&&items.length){const hint=document.createElement('p');hint.className='empty-plan';hint.textContent='Выполненные задачи скрыты';list.append(hint);}
    const appendTask = task => {
      const card=document.createElement('article');card.className='task'+(task.done?' done':'')+(task.highlight?' highlighted':'');card.dataset.color=task.color;card.dataset.taskIndex=task.index;
      card.innerHTML=`<div class="task-main"><input type="checkbox" aria-label="Отметить задачу ${esc(task.text)}" ${task.done?'checked':''}><div class="task-content"><button class="task-title" aria-label="Изменить задачу ${esc(task.text)}">${esc(task.text)}</button></div></div><button type="button" class="task-note-preview" aria-label="Редактировать заметку ${esc(task.text)}"></button><div class="task-counters"><span class="task-due"></span><button type="button" class="text-button" data-children></button><button type="button" class="text-button" data-comments></button></div><div class="task-children"></div><div class="task-editor-slot"></div><div class="task-discussion task-inline-options"></div>`;
      const host=card.querySelector('.task-editor-slot'),titleButton=card.querySelector('.task-title'),preview=card.querySelector('.task-note-preview');
      const updatePreview=()=>{
        card.querySelector('.task-main > input').setAttribute('aria-label','Отметить задачу '+task.text);titleButton.textContent=task.text;titleButton.setAttribute('aria-label','Изменить задачу '+task.text);
        const copy=document.createElement('div');copy.innerHTML=md(task.note);preview.textContent=copy.textContent.trim();preview.hidden=!task.note;preview.setAttribute('aria-label','Редактировать заметку '+task.text);
        refreshCounters();
        card.dataset.color=task.color;card.dataset.taskIndex=task.index;card.classList.toggle('highlighted',task.highlight);card.classList.toggle('done',task.done);
        const due=card.querySelector('.task-due');due.textContent=task.due&&!task.done?(task.due<today?'Просрочено · ':task.due===today?'Сегодня · ':'До ')+task.due:'';due.classList.toggle('overdue',!!task.due&&task.due<today);
      };
      const counters=card.querySelector('.task-counters');
      const childList=card.querySelector('.task-children');
      let childrenOpen=localStorage.getItem('horizon:children:'+(task.id||doc.path+':'+task.index))==='true';
      const childrenToggle=counters.querySelector('[data-children]'),commentsToggle=counters.querySelector('[data-comments]');
      childrenToggle.onclick=async()=>{if(activePlannerEditor&&childList.contains(activePlannerEditor.card)&&!await activePlannerEditor.flush())return;childrenOpen=!childrenOpen;localStorage.setItem('horizon:children:'+(task.id||doc.path+':'+task.index),String(childrenOpen));refreshCounters();};
      commentsToggle.onclick=async()=>{await openEditor();host.querySelector('[aria-label="Комментарии"]')?.click();};
      const refreshCounters=()=>{
        childrenToggle.hidden=!task.children.length;childrenToggle.textContent=`${task.children.filter(c=>c.done).length}/${task.children.length} подзадач`;childrenToggle.setAttribute('aria-expanded',String(childrenOpen));
        childList.hidden=!childrenOpen;commentsToggle.hidden=!task.comments.length;commentsToggle.textContent=`Комментарии · ${task.comments.length}`;
        counters.hidden=!task.children.length&&!task.comments.length&&(!task.due||task.done);
      };
      updatePreview();
      card.querySelector('.task-main > input').onchange=act(async()=>{await mutate(doc,task,{done:!task.done});await redraw();});
      const appendChild = child => {
        const row=document.createElement('div');row.className='task-child'+(child.done?' done':'');row.dataset.color=child.color;if(child.id)row.dataset.childId=child.id;row.style.setProperty('--task-level',child.level);
        row.innerHTML=`<input type="checkbox" aria-label="Отметить подзадачу ${esc(child.text)}" ${child.done?'checked':''}><button class="task-title" aria-label="Изменить подзадачу ${esc(child.text)}">${esc(child.text)}</button><select class="child-color" aria-label="Цвет подзадачи ${esc(child.text)}">${planner.colors.map((c,i)=>`<option value="${c}" ${c===child.color?'selected':''}>${['Зелёный','Жёлтый','Голубой','Розовый','Фиолетовый','Нейтральный'][i]}</option>`).join('')}</select>`;
        row.querySelector('input').onchange=act(async()=>{try{await mutate(doc,task,{done:!child.done},{...(child.id?{childId:child.id}:{childIndex:child.index})});row.classList.toggle('done',child.done);row.hidden=!showCompleted&&child.done;refreshCounters();}finally{row.querySelector('input[type=checkbox]').checked=child.done;}});
        const childTitle=row.querySelector('.task-title');
        childTitle.onclick=act(async()=>{
          focusColumn(key);
          const draftPath=plannerDraftKey(doc,task,'child-'+(child.id||child.index)),stored=draft(draftPath);
          let revision=stored?.revision??doc.revision,timer=null,pending=null,closed=false,conflict=false;
          const box=document.createElement('form');box.className='task-child-editor';box.innerHTML='<input maxlength="1000" aria-label="Название подзадачи"><span class="task-inline-status" role="status"></span><button type="submit" class="task-icon" aria-label="Сохранить подзадачу">✓</button><button type="button" class="task-icon" aria-label="Отменить несохранённое">×</button>';
          childTitle.hidden=true;childTitle.after(box);const field=box.querySelector('input'),message=box.querySelector('[role=status]');field.value=stored?.content??child.text;
          const stash=()=>keepDraft(draftPath,{revision,content:field.value});
          const close=()=>{clearTimeout(timer);closed=true;box.remove();childTitle.hidden=false;childTitle.textContent=child.text;childTitle.setAttribute('aria-label','Изменить подзадачу '+child.text);row.querySelector('input[type=checkbox]').setAttribute('aria-label','Отметить подзадачу '+child.text);row.querySelector('select').setAttribute('aria-label','Цвет подзадачи '+child.text);if(activePlannerEditor?.card===row)activePlannerEditor=null;};
          const flush=async(shouldClose=true)=>{
            clearTimeout(timer);if(closed)return true;if(conflict)return false;if(pending){if(!await pending)return false;return flush(shouldClose);}
            const text=field.value.trim();if(!text){message.textContent='Укажите название';stash();return false;}
            if(text===child.text){clearDraft(draftPath);if(shouldClose)close();return true;}
            stash();message.textContent='Сохраняется…';
            pending=(async()=>{try{await mutate(doc,task,{text},{...(child.id?{childId:child.id}:{childIndex:child.index}),revision:()=>revision});revision=doc.revision;if(field.value.trim()===text){clearDraft(draftPath);message.textContent='Сохранено';}else stash();return true;}catch(error){message.textContent=error.message;conflict=error.status===409;if(conflict){const compare=document.createElement('button');compare.type='button';compare.className='text-button';compare.textContent='Сравнить с файлом';box.append(compare);compare.onclick=async()=>{try{const fresh=await read(doc.path),parent=planner.tasks(fresh.content).find(t=>t.id===task.id),current=parent?.children.find(c=>c.id===child.id&&child.id);message.textContent=current?'В файле: '+current.text:'Подзадача не найдена по ID. Черновик сохранён.';compare.textContent='Сохранить мой текст поверх этой версии';compare.disabled=!current;compare.onclick=async()=>{Object.assign(doc,fresh);Object.assign(child,current);revision=fresh.revision;conflict=false;compare.remove();await flush(false);};}catch(e){message.textContent=e.message;}};}return false;}})();
            const ok=await pending;pending=null;if(ok&&field.value.trim()!==child.text)return flush(shouldClose);if(ok&&shouldClose)close();return ok;
          };
          activePlannerEditor={card:row,flush,rebase:(path,from,to)=>{if(path===doc.path&&revision===from)revision=to;}};
          field.oninput=()=>{stash();message.textContent='Есть изменения';clearTimeout(timer);timer=setTimeout(()=>flush(false),700);};
          box.onsubmit=async event=>{event.preventDefault();if(await flush())childTitle.focus();};
          box.querySelector('[type=button]').onclick=()=>{if(pending)return;clearDraft(draftPath);close();childTitle.focus();};
          box.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();box.querySelector('[type=button]').click();}};
          box.addEventListener('focusout',event=>{if(event.relatedTarget&&!row.contains(event.relatedTarget))flush();});field.focus();
        });
        row.querySelector('select').onchange=event=>act(async()=>{try{await mutate(doc,task,{color:event.target.value},{...(child.id?{childId:child.id}:{childIndex:child.index})});row.dataset.color=child.color;}finally{event.target.value=child.color;}})();
        childList.append(row);
      };
      task.children.filter(c=>showCompleted||!c.done).forEach(appendChild);
      const openEditor=async (focusNote=false)=>{
        if(activePlannerEditor?.card===card){host.querySelector(focusNote?'textarea':'input[name=title]')?.focus();return;}
        if(activePlannerEditor&&!await activePlannerEditor.flush())return;
        focusColumn(key);
        card.classList.add('task-active');titleButton.hidden=true;preview.hidden=true;card.querySelector('.task-content').append(host);
        const draftKey=plannerDraftKey(doc,task,'combined'),stored=draft(draftKey);
        let values={text:task.text,note:task.note};
        if(stored){try{values=JSON.parse(stored.content);}catch{}}
        const oldNote=draft(plannerDraftKey(doc,task,'note'));
        if(!stored&&oldNote)values.note=oldNote.content;
        let revision=stored?.revision??oldNote?.revision??doc.revision,pending=null,closed=false,saveTimer=null,conflicted=false;
        host.innerHTML=`<form class="task-direct-editor"><label class="sr-only">Название задачи<input name="title" maxlength="1000" required autocomplete="off"></label><label class="task-note-label">Заметка<textarea name="note" rows="1" placeholder="Добавить заметку…"></textarea></label><div class="task-icon-toolbar" role="toolbar" aria-label="Действия задачи"></div><p class="task-inline-status" role="status" hidden></p><div class="task-inline-options"></div></form>`;
        const form=host.querySelector('form'),titleInput=form.querySelector('[name=title]'),noteInput=form.querySelector('[name=note]'),message=form.querySelector('[role=status]'),toolbar=form.querySelector('.task-icon-toolbar'),options=form.querySelector('.task-inline-options');
        // Keep the title at its original position; both fields belong to one form.
        titleInput.parentElement.classList.remove('sr-only');titleInput.parentElement.classList.add('task-title-field');titleInput.parentElement.firstChild.textContent='';
        titleInput.setAttribute('aria-label','Название задачи');noteInput.setAttribute('aria-label','Заметка задачи');titleInput.value=values.text;noteInput.value=values.note;
        const notify=(text,error=false)=>{message.textContent=text;message.hidden=!text;message.classList.toggle('error',error);};
        const persist=()=>{keepDraft(draftKey,{revision,content:JSON.stringify({text:titleInput.value,note:noteInput.value})});notify('Есть изменения');};
        const fitNote=()=>{noteInput.style.height='auto';noteInput.style.height=Math.min(280,Math.max(document.activeElement===noteInput?48:24,noteInput.scrollHeight))+'px';};
        const changed=()=>{persist();fitNote();clearTimeout(saveTimer);saveTimer=setTimeout(()=>{if(!titleInput.matches(':read-only'))flush(false);},700);};
        titleInput.oninput=changed;noteInput.oninput=changed;noteInput.onfocus=fitNote;fitNote();
        const close=()=>{clearTimeout(saveTimer);closed=true;card.classList.remove('task-active');titleButton.hidden=false;host.replaceChildren();card.querySelector('.task-discussion').replaceChildren();card.insertBefore(host,card.querySelector('.task-discussion'));updatePreview();if(activePlannerEditor?.card===card)activePlannerEditor=null;};
        const flush=async(shouldClose=true)=>{
          clearTimeout(saveTimer);if(closed)return true;if(conflicted)return false;
          if(pending){const ok=await pending;if(!ok)return false;return flush(shouldClose);}
          const text=titleInput.value.trim(),note=noteInput.value;
          if(!text){notify('Укажите название задачи.',true);titleInput.focus();return false;}
          if(text===task.text&&note===task.note){clearDraft(draftKey);if(shouldClose)close();return true;}
          persist();notify('Сохраняется…');
          pending=(async()=>{
            try{
              const result=await mutate(doc,task,{text,note},{revision:()=>revision});revision=result.document.revision;
              if(titleInput.value.trim()===text&&noteInput.value===note){clearDraft(draftKey);notify('Сохранено');}else persist();clearDraft(plannerDraftKey(doc,task,'note'));updatePreview();return true;
            }catch(error){notify(error.message,true);if(error.status===409){conflicted=true;const comparison=document.createElement('div');comparison.className='planner-compare';comparison.innerHTML='<button type="button" class="text-button">Сравнить с файлом</button>';form.append(comparison);comparison.querySelector('button').onclick=async()=>{try{const fresh=await read(doc.path),current=planner.tasks(fresh.content).find(t=>t.id===task.id&&task.id);comparison.innerHTML='<p>Сейчас в файле:</p><pre></pre><button type="button" class="button">Сохранить мой текст поверх этой версии</button>';comparison.querySelector('pre').textContent=current?current.text+'\n\n'+current.note:'Задача не найдена по ID. Скопируйте черновик и перечитайте список.';const confirm=comparison.querySelector('button');confirm.disabled=!current;confirm.onclick=async()=>{Object.assign(doc,fresh);Object.assign(task,current);revision=fresh.revision;conflicted=false;comparison.remove();persist();await flush(false);};}catch(e){notify(e.message,true);}};}return false;}
          })();
          const ok=await pending;pending=null;if(ok&&(titleInput.value.trim()!==task.text||noteInput.value!==task.note))return flush(shouldClose);if(ok&&shouldClose)close();return ok;
        };
        activePlannerEditor={card,flush,rebase:(path,from,to)=>{if(path===doc.path&&revision===from)revision=to;}};
        form.addEventListener('focusout',event=>{if(event.relatedTarget&&!card.contains(event.relatedTarget)&&activePlannerEditor?.card===card)flush();});
        const symbols={save:'✓',cancel:'×',child:'＋',color:'◉',highlight:'▧',due:'◷',move:'⇥',up:'↑',down:'↓',drag:'↕',remove:'⌫'};
        const more=document.createElement('details');more.className='task-more';
        more.innerHTML='<summary class="task-icon" aria-label="Другие действия" title="Другие действия">⋯</summary><div class="task-more-list"></div>';toolbar.append(more);
        const icon=(name,label,handler)=>{const primary=['save','color'].includes(name),button=document.createElement('button');button.type='button';button.className=primary?'task-icon':'task-menu-action';button.textContent=primary?symbols[name]:label;button.title=label;button.setAttribute('aria-label',label);button.onclick=async event=>{event.preventDefault();if(!primary)more.open=false;try{await handler(button);}catch(error){notify(error.message,true);}};if(primary)toolbar.insertBefore(button,more);else more.lastElementChild.append(button);return button;};
        icon('save','Сохранить задачу',()=>flush());
        icon('cancel','Отменить несохранённое',()=>{if(pending)return;clearDraft(draftKey);close();titleButton.focus();});
        const action=fn=>async()=>{if(await flush(false))await fn();};
        icon('child','Добавить подзадачу',()=>{
          options.innerHTML='<label>Новая подзадача<input name="new-child" maxlength="1000" autocomplete="off"></label><button type="button" class="text-button">Добавить</button><p class="child-save-status" role="status"></p>';
          const input=options.querySelector('input'),status=options.querySelector('.child-save-status'),childKey=plannerDraftKey(doc,task,'new-child');input.value=draft(childKey)?.content||'';input.focus();
          let adding=false,retry=draft(childKey)?.id?{id:draft(childKey).id,text:input.value.trim()}:null;
          input.oninput=()=>{if(retry?.text!==input.value.trim())retry=null;keepDraft(childKey,{content:input.value,id:retry?.id});};
          const add=async()=>{
            if(adding||!input.value.trim())return;adding=true;
            const entry=retry&&retry.text===input.value.trim()?retry:{id:crypto.randomUUID(),text:input.value.trim()};retry=entry;keepDraft(childKey,{content:input.value,id:entry.id});
            try{if(!await flush(false))return;await mutate(doc,task,{addChild:entry.text},{addChildId:entry.id});revision=doc.revision;
              const child=task.children.find(c=>c.id===entry.id);if(child&&!childList.querySelector(`[data-child-id="${entry.id}"]`)){appendChild(child);childList.lastElementChild.dataset.childId=entry.id;}
              childrenOpen=true;refreshCounters();if(input.value.trim()===entry.text)input.value='';keepDraft(childKey,{content:input.value});retry=null;status.textContent='Сохранено';input.focus();
            }catch(error){status.textContent='Не сохранено: '+error.message;}finally{adding=false;}
          };
          options.querySelector('button').onclick=add;
          input.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!event.repeat)add();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();options.replaceChildren();titleInput.focus();}};
        });
        icon('comments','Комментарии',()=>{
          const options=card.querySelector('.task-discussion');
          options.innerHTML='<div class="task-comments"></div><label>Комментарий<textarea maxlength="10000" rows="2" placeholder="Написать комментарий…"></textarea></label><button type="button" class="button">Отправить</button><p role="status"></p>';
          const list=options.querySelector('.task-comments'),field=options.querySelector('textarea'),send=options.querySelector('button'),status=options.querySelector('[role=status]'),commentKey=plannerDraftKey(doc,task,'comment');
          let entry=draft(commentKey);field.value=entry?.content||'';
          const persistComment=()=>{entry={id:entry?.content===field.value?entry.id:crypto.randomUUID(),content:field.value};keepDraft(commentKey,entry);};field.oninput=persistComment;
          const drawComments=()=>{list.replaceChildren();task.comments.forEach(comment=>{const article=document.createElement('article'),meta=document.createElement('small'),body=document.createElement('p');meta.textContent=comment.author+' · '+new Date(comment.createdAt).toLocaleString('ru-RU');meta.title=comment.createdAt;body.textContent=comment.text;article.append(meta,body);list.append(article);});};drawComments();
          const post=async()=>{
            if(send.disabled||!field.value.trim())return;persistComment();send.disabled=true;const sent={...entry};
            try{if(!await flush(false))return;await mutate(doc,task,{}, {action:'addComment',comment:{id:sent.id,text:sent.content}});revision=doc.revision;drawComments();refreshCounters();if(field.value===sent.content){field.value='';entry=null;clearDraft(commentKey);}else{entry={id:crypto.randomUUID(),content:field.value};keepDraft(commentKey,entry);}status.textContent='Отправлено';}
            catch(error){status.textContent='Не отправлено: '+error.message;}finally{send.disabled=false;}
          };
          send.onclick=post;field.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();event.stopPropagation();post();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();options.replaceChildren();titleInput.focus();}};field.focus();
        });
        icon('color','Цвет задачи',()=>{
          options.innerHTML='<div class="task-palette" role="group" aria-label="Цвет задачи"></div>';
          planner.colors.forEach((color,i)=>{const swatch=document.createElement('button');swatch.type='button';swatch.className='color-swatch';swatch.dataset.color=color;swatch.setAttribute('aria-label',['Зелёный','Жёлтый','Голубой','Розовый','Фиолетовый','Нейтральный'][i]);swatch.setAttribute('aria-pressed',String(task.color===color));swatch.onclick=async()=>{if(await flush(false)){try{await mutate(doc,task,{color});revision=doc.revision;updatePreview();options.replaceChildren();}catch(error){notify(error.message,true);}}};options.firstElementChild.append(swatch);});
        });
        const highlight=icon('highlight','Подсветить задачу',async button=>{if(await flush(false)){await mutate(doc,task,{highlight:!task.highlight});revision=doc.revision;updatePreview();button.setAttribute('aria-pressed',String(task.highlight));}});highlight.setAttribute('aria-pressed',String(task.highlight));
        icon('due','Срок задачи',()=>{
          options.innerHTML=`<label>Срок<input type="date" min="1900-01-01" max="9999-12-31" value="${esc(task.due||'')}"></label>`;
          options.querySelector('input').onchange=async event=>{if(await flush(false)){try{await mutate(doc,task,{due:event.target.value||null});revision=doc.revision;updatePreview();options.replaceChildren();}catch(error){notify(error.message,true);}}};
        });
        icon('move','Перенести задачу',()=>{
          options.innerHTML='<label>Горизонт<select><option value="">Выбрать…</option>'+periods.map(([k,t],i)=>`<option value="${i}" ${i===columnIndex?'disabled':''}>${t}</option>`).join('')+'</select></label><label>На дату<input type="date" min="1900-01-01" max="9999-12-31"></label><button type="button" class="task-icon" aria-label="Перенести на дату" title="Перенести на дату">⇥</button>';
          options.querySelector('select').onchange=async event=>{const value=event.target.value;if(value!==''&&await flush(false)){close();await act(()=>move(doc,task,boardDocs[Number(value)]))();}};
          options.querySelector('button').onclick=async()=>{const date=options.querySelector('input').value;if(!planner.dateValid(date)){notify('Выберите дату.',true);return;}if(await flush(false)){close();await act(async()=>move(doc,task,await api('/api/planner/day?date='+date)))();}};
        });
        const position=items.indexOf(task);
        icon('up','Выше',action(async()=>{if(position){close();await move(doc,task,doc,items[position-1].index);}}));
        icon('down','Ниже',action(async()=>{if(position<items.length-1){close();await move(doc,task,doc,items[position+2]?.index??null);}}));
        icon('remove','Удалить задачу',()=>{
          options.innerHTML='<p>Удалить задачу вместе с заметкой и подзадачами?</p><button type="button" class="button" data-delete>Удалить</button><button type="button" class="button" data-cancel>Отмена</button>';
          options.querySelector('[data-cancel]').onclick=()=>options.replaceChildren();options.querySelector('[data-delete]').onclick=async()=>{if(await flush(false)){try{const result=await api('/api/delete-task',{path:doc.path,revision:doc.revision,index:task.index});horizonTaskUndo={path:doc.path,revision:result.revision,undoVersion:result.undoVersion};close();await redraw();}catch(error){notify(error.message,true);}}};
        });
        form.onsubmit=event=>{event.preventDefault();flush();};
        form.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();if(more.open){more.open=false;more.querySelector('summary').focus();}else toolbar.querySelector('[aria-label="Отменить несохранённое"]').click();}else if(event.key==='Enter'&&(event.target===titleInput||event.metaKey||event.ctrlKey)){event.preventDefault();flush();}};
        if(stored||oldNote)notify(revision!==doc.revision?'Восстановлен черновик от другой версии. При сохранении будет проверен конфликт.':'Восстановлен черновик');
        (focusNote?noteInput:titleInput).focus();
      };
      card.draggable=true;
      card.ondragstart=event=>event.preventDefault();
      card.onpointerdown=event=>{
        if(event.button!==0||event.pointerType==='touch'||plannerBusy||card.classList.contains('task-active')||event.target.closest('input,textarea,select,a,summary,.task-counters,.task-children,button:not(.task-title):not(.task-note-preview)'))return;
        const start={x:event.clientX,y:event.clientY};let started=false,lastColumn=null;
        const pointerMove=e=>{
          if(!started&&Math.hypot(e.clientX-start.x,e.clientY-start.y)<6)return;
          if(!started){started=true;draggedTask={doc,task};card.classList.add('task-dragging');document.body.classList.add('planner-dragging');}
          e.preventDefault();const target=document.elementFromPoint(e.clientX,e.clientY);lastColumn=target?.closest('.horizon-column');
          if(lastColumn)lastColumn.ondragover({target,clientX:e.clientX,clientY:e.clientY,preventDefault(){},dataTransfer:{}});else clearDrop();
        };
        const cleanup=()=>{window.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);window.removeEventListener('pointercancel',cancel);window.removeEventListener('keydown',keys);document.body.classList.remove('planner-dragging');};
        const cancel=()=>{cleanup();if(started)stopDrag();};
        const keys=e=>{if(e.key==='Escape'){e.preventDefault();cancel();}};
        const pointerUp=e=>{cleanup();if(!started)return;const target=document.elementFromPoint(e.clientX,e.clientY),column=target?.closest('.horizon-column');if(column)column.ondrop({target,clientX:e.clientX,clientY:e.clientY,preventDefault(){},stopPropagation(){}});else stopDrag();};
        window.addEventListener('pointermove',pointerMove,{passive:false});window.addEventListener('pointerup',pointerUp);window.addEventListener('pointercancel',cancel);window.addEventListener('keydown',keys);
      };
      titleButton.onclick=()=>{if(Date.now()>suppressTaskClickUntil)openEditor();};preview.onclick=()=>{if(Date.now()>suppressTaskClickUntil)openEditor(true);};
      card.onclick=event=>{if(Date.now()>suppressTaskClickUntil&&!event.target.closest('button,input,textarea,select,a,form'))openEditor();};
      list.append(card);
      return card;
    };
    visible.forEach(appendTask);
    const dropPosition=event=>{
      const target=event.target.closest('[data-task-index]');
      if(!target)return {before:null,target:null};
      const index=items.findIndex(t=>t.index===Number(target.dataset.taskIndex)),rect=target.getBoundingClientRect(),after=event.clientY>rect.top+rect.height/2;
      return {target,after,before:after?(items[index+1]?.index??null):items[index]?.index??null};
    };
    column.ondragover=event=>{
      if(!draggedTask)return;event.preventDefault();event.dataTransfer.dropEffect='move';clearDrop();
      const position=dropPosition(event);if(position.target)position.target.classList.add(position.after?'drop-after':'drop-before');else column.classList.add('drop-column');
      const board=$('.board'),bounds=board.getBoundingClientRect();if(event.clientX<bounds.left+45)board.scrollLeft-=18;else if(event.clientX>bounds.right-45)board.scrollLeft+=18;
      const boundsY=column.getBoundingClientRect();if(event.clientY<boundsY.top+45)column.scrollTop-=18;else if(event.clientY>Math.min(boundsY.bottom,innerHeight-80)-45)column.scrollTop+=18;
    };
    column.ondragleave=event=>{if(!column.contains(event.relatedTarget))clearDrop();};
    column.ondrop=event=>{
      if(!draggedTask)return;event.preventDefault();event.stopPropagation();const source=draggedTask,position=dropPosition(event);stopDrag();
      const sourceIndex=items.indexOf(source.task);
      if(source.doc.path===doc.path&&(position.before===source.task.index||position.before===(items[sourceIndex+1]?.index??null)))return;
      act(()=>move(source.doc,source.task,doc,position.before))();
    };
    const addForm=column.querySelector('.add-task'),addInput=addForm.querySelector('input');
    const addKey='planner:add:'+doc.path;addInput.value=draft(addKey)?.content||'';
    const showFailed=entry=>{
      const box=document.createElement('div');box.className='planner-add-error';box.setAttribute('role','status');box.textContent='Не сохранено: '+entry.text+' ';
      const retry=document.createElement('button');retry.type='button';retry.className='text-button';retry.textContent='Повторить';retry.onclick=async()=>{retry.disabled=true;try{const result=await mutate(doc,null,{text:entry.text},{createId:entry.id});if(!items.some(t=>t.id===result.task.id)){items.push(result.task);appendTask(result.task);}clearDraft(addKey+':failed:'+entry.id);box.remove();}catch(error){toast(error.message);retry.disabled=false;}};box.append(retry);addForm.after(box);
    };
    for(const storageKey of Object.keys(localStorage)){if(storageKey.startsWith(draftKey(addKey+':failed:'))){try{const entry=JSON.parse(localStorage.getItem(storageKey));showFailed({id:entry.id,text:entry.content});}catch{}}}
    addInput.oninput=()=>keepDraft(addKey,{content:addInput.value});
    addInput.onkeydown=event=>{if(event.isComposing||event.repeat&&event.key==='Enter'){event.preventDefault();return;}if(event.key==='Escape'){event.preventDefault();addInput.blur();}};
    addForm.onsubmit=async event=>{
      event.preventDefault();const value=addInput.value.trim();if(!value)return;
      const entry={id:crypto.randomUUID(),text:value};
      keepDraft(addKey+':failed:'+entry.id,{content:entry.text,id:entry.id});
      addInput.value='';keepDraft(addKey,{content:''});
      try{
        const result=await mutate(doc,null,{text:entry.text},{createId:entry.id});
        if(!items.some(t=>t.id===result.task.id)){items.push(result.task);appendTask(result.task);}
        clearDraft(addKey+':failed:'+entry.id);column.querySelector('.empty-plan')?.remove();
      }catch(error){
        showFailed(entry);toast(error.message);
      }
    };
    $('.board').append(column);
  });
  $('.board').scrollLeft=previousScroll;
  $('.board').onkeydown=event=>{if(event.key==='Escape'&&draggedTask){event.preventDefault();stopDrag();}};
  $('.board').onscroll=event=>localStorage.setItem('horizon:scroll',String(event.target.scrollLeft));

}

async function openHorizonEditor(path) {
  const slot = $('#horizon-editor-slot');
  if (!slot) return;
  if (horizonEditor?.path === path && slot.querySelector('.horizon-editor')) { slot.querySelector('textarea')?.focus(); return; }
  try {
    const doc = await read(path); const saved = draft(path);
    const session = {doc, path, value:saved?.content ?? doc.content, revision:saved?.revision || doc.revision, error:null, inflight:null, timer:null};
    if (session.revision !== doc.revision) session.error = Object.assign(new Error('Файл изменился на диске. Черновик сохранён; сравните его перед загрузкой.'), {status:409});
    horizonEditor = session;
    const draw = () => {
      slot.innerHTML = `<section class="horizon-editor"><div class="horizon-editor-head"><div><span class="eyebrow">Horizon document</span><h2>${esc(doc.title)}</h2><p class="filepath">${esc(doc.sourcePath || path)}</p></div><button class="icon-button" data-close aria-label="Закрыть редактор">×</button></div><label class="sr-only" for="horizon-source">Markdown горизонта</label><textarea id="horizon-source" spellcheck="false"></textarea><div class="horizon-editor-actions"><span class="save-status" role="status" id="horizon-status"></span><div><button class="button" data-reload>↻ С диска</button><button class="button primary" data-save>Сохранить</button></div></div><div class="inline-error" role="status"></div></section>`;
      const input = slot.querySelector('#horizon-source'); input.value = session.value;
      const notify = () => { status(slot.querySelector('#horizon-status'), session.error ? 'Не сохранено' : session.inflight ? 'Сохраняется…' : session.value !== session.doc.content ? 'Есть изменения…' : 'Сохранено', Boolean(session.error)); slot.querySelector('.inline-error').textContent = session.error?.message || ''; };
      const flush = async () => {
        clearTimeout(session.timer); if (session.inflight) { await session.inflight; return !session.error; } if (session.error) return false; if (session.value === session.doc.content) return true;
        const value = session.value;
        session.inflight = (async () => { try { session.doc = await api('/api/document', {path, revision:session.revision, content:value}); session.revision = session.doc.revision; if (session.value === session.doc.content) clearDraft(path); else keepDraft(path, {revision:session.revision, content:session.value}); } catch (error) { session.error = error; keepDraft(path, {revision:session.revision, content:session.value}); } })();
        notify(); await session.inflight; session.inflight = null; notify(); return !session.error;
      };
      input.oninput = () => { session.value = input.value; keepDraft(path, {revision:session.revision, content:session.value}); session.error = session.error?.status === 409 ? session.error : null; notify(); clearTimeout(session.timer); if (!session.error) session.timer = setTimeout(flush, 900); };
      input.onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); flush(); } };
      slot.querySelector('[data-save]').onclick = async () => { await flush(); if (!session.error) { await renderRoute(); toast('Сохранено в файл'); } };
      slot.querySelector('[data-close]').onclick = () => { if (session.value !== session.doc.content || session.error) { inlineConfirm(slot, 'Есть несохранённый текст. Закрыть и оставить черновик?', () => { slot.innerHTML = ''; horizonEditor = null; }); return; } slot.innerHTML = ''; horizonEditor = null; };
      slot.querySelector('[data-reload]').onclick = async () => { if (session.inflight) await session.inflight; if (session.value !== session.doc.content || session.error) { inlineConfirm(slot, 'Загрузить версию с диска и удалить текущий черновик?', async () => { clearTimeout(session.timer); clearDraft(path); horizonEditor = null; try { await openHorizonEditor(path); } catch (error) { toast(error.message); } }); return; } try { horizonEditor = null; await openHorizonEditor(path); } catch (error) { toast(error.message); } };
      notify(); input.focus();
    };
    draw();
  } catch (error) { toast(error.message); }
}

let dialogSequence = 0;
function openModal(title, content, {className = '', singleton = true} = {}) {
  if (singleton) document.querySelectorAll('dialog[data-singleton="true"]').forEach(panel => panel.close());
  const panel = document.createElement('dialog');
  const titleId = 'dialog-title-' + ++dialogSequence;
  panel.className = `horizon-dialog inline-panel ${className}`;
  panel.dataset.singleton = String(singleton);
  panel.setAttribute('aria-labelledby', titleId);
  panel.innerHTML = `<div class="inline-panel-head"><h2 id="${titleId}">${esc(title)}</h2><button type="button" class="icon-button" data-close aria-label="Закрыть окно">×</button></div>${content}`;
  const close = () => { if (panel.dataset.busy !== 'true') panel.close(); };
  panel.querySelector('[data-close]').onclick = close;
  panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
  panel.addEventListener('click', event => {
    if (event.target !== panel) return;
    const rect = panel.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  panel.addEventListener('close', () => panel.remove(), {once:true});
  document.body.append(panel);
  panel.showModal();
  (panel.querySelector('input,textarea,select') || panel.querySelector('[data-cancel]') || panel.querySelector('[data-close]')).focus({preventScroll:true});
  return panel;
}
window.HorizonDialogs = {open:openModal};
function inlinePanel(title, content, host = $('.document-main') || main, className = '') {
  return openModal(title, content, {className});
}
function inlineConfirm(host, message, action) {
  const box = openModal('Подтверждение', `<p class="inline-panel-message">${esc(message)}</p><div class="inline-actions"><button class="button" data-cancel>Отмена</button><button class="button primary" data-confirm>Продолжить</button></div>`, {singleton:false});
  box.querySelector('[data-cancel]').onclick = () => { if (box.dataset.busy !== 'true') box.close(); }; box.querySelector('[data-confirm]').onclick = async () => { box.dataset.busy = 'true'; box.querySelector('[data-confirm]').disabled = true; try { await action(); box.close(); } catch (error) { toast(error.message); box.querySelector('[data-confirm]').disabled = false; } finally { box.dataset.busy = 'false'; } };
  return box;
}
function formInline(title, fields, action, label = 'Сохранить', note = '', host = $('.document-main') || main) {
  const panel = inlinePanel(title, `<form>${fields}${note ? `<p class="inline-panel-note">${esc(note)}</p>` : ''}<p class="save-status" role="status"></p><div class="inline-actions"><button type="button" class="button" data-cancel>Отмена</button><button class="button primary" type="submit">${esc(label)}</button></div></form>`, host);
  panel.querySelector('[data-cancel]').onclick = () => { if (panel.dataset.busy !== 'true') panel.close(); };
  panel.querySelector('form').onsubmit = async event => { event.preventDefault(); const button = panel.querySelector('[type=submit]'); button.disabled = true; panel.dataset.busy = 'true'; try { await action(new FormData(event.target)); if (panel.isConnected) panel.close(); } catch (error) { status(panel.querySelector('.save-status'), error.message, true); button.disabled = false; } finally { panel.dataset.busy = 'false'; } };
  return panel;
}
const field = (name, label, value = '', kind = 'input') => `<label class="form-field">${esc(label)}${kind === 'textarea' ? `<textarea name="${esc(name)}">${esc(value)}</textarea>` : `<input name="${esc(name)}" value="${esc(value)}" required>`}</label>`;

function renderAgentSessionPanel(doc) {
  const root = $('.document-main');
  if (!root || doc?.path !== 'reviews/agent-overview.md') return;
  root.querySelector('.agent-session-panel')?.remove();
  const selectedProject = agentSessionResult?.projectId ?? null;
  const projectOptions = projectRoots.map(project => `<option value="${esc(project.id || '')}" ${project.id === selectedProject ? 'selected' : ''}>${esc(project.name)}</option>`).join('');
  const taskOptions = (doc.rows || []).filter(row => /^T\d+$/.test(row.id || '')).map(row => {
    const title = typeof row.taskTitle === 'string' ? row.taskTitle : typeof row.theme === 'string' ? row.theme : typeof row.task === 'string' ? row.task : row.id;
    return `<option value="${esc(row.id)}">${esc(row.id)} · ${esc(title.replace(/^T\d+\s*[·.:-]?\s*/, ''))}</option>`;
  }).join('');
  const result = agentSessionResult;
  const resultStatus = result ? ({'On review':'Needs review', 'В работе':'In progress', 'На проверке':'Needs review', 'Закрыто':'Closed'}[result.status] || result.status || 'In progress') : '';
  const resultBlock = result ? `<details class="agent-session-result"><summary>Agent brief · ${esc(result.taskId)}</summary><p><strong>${esc(result.taskId || '')}</strong> · ${esc(resultStatus)} · ${esc(result.provider || '')}</p><p>Copy this instruction to the agent:</p><textarea data-agent-instruction readonly>${esc(result.instruction || '')}</textarea><button class="button" type="button" data-copy-instruction>Copy instruction</button></details>` : '';
  closeExistingInlinePanel();
  const panel = document.createElement('section');
  panel.className = 'agent-session-panel';
  panel.dataset.singleton = 'true';
  panel.innerHTML = `${resultBlock}<details class="agent-session-details"><summary class="button">＋ New task</summary><div class="agent-session-form-wrap"><form class="agent-session-form"><label class="form-field">Project<select name="projectId">${projectOptions}</select></label><label class="form-field">Task title<input name="taskTitle" maxlength="1000" required placeholder="What should be followed up?"></label><details class="agent-session-options"><summary>Details / agent</summary><label class="form-field">Summary (optional)<textarea name="summary" maxlength="100000" rows="3" placeholder="Purpose or scope"></textarea></label><div class="agent-session-fields"><label class="form-field">Provider<select name="provider"><option value="codex">Codex</option><option value="claude">Claude</option><option value="other">Other</option></select></label><label class="form-field">Session ID (optional)<input name="sessionId" maxlength="200" placeholder="Thread or task ID"></label></div><label class="form-field">Link to existing task (optional)<select name="taskId"><option value="">Create a new task row</option>${taskOptions}</select></label></details><p class="save-status" data-agent-session-status role="status"></p><div class="inline-actions"><button type="button" class="button" data-cancel-registration>Cancel</button><button type="submit" class="button primary">Create task</button></div></form></div></details>`;
  root.querySelector('.document-chrome').prepend(panel);
  panel.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const form = event.target, button = form.querySelector('[type=submit]'), statusNode = panel.querySelector('[data-agent-session-status]');
    const data = new FormData(form), taskTitle = String(data.get('taskTitle') || '').trim();
    if (!taskTitle) { status(statusNode, 'Enter a task title.', true); return; }
    button.disabled = true; status(statusNode, 'Saving…');
    try {
      const payload = {projectId:data.get('projectId') || null, taskTitle, summary:String(data.get('summary') || '').trim(), provider:data.get('provider') || 'codex', sessionId:String(data.get('sessionId') || '').trim() || undefined, taskId:data.get('taskId') || undefined};
      await settled(doc.path);
      payload.mode = payload.taskId ? 'link' : 'create';
      const saved = await api('/api/agent-session', payload);
      agentSessionResult = saved;
      const fresh = await read(saved.docPath || doc.path);
      renderVisual(fresh);
      document.querySelector('[aria-label="Добавить тему в таблицу"]')?.focus();
    } catch (error) { status(statusNode, error.message, true); button.disabled = false; }
  };
  const taskTrigger=panel.querySelector('.agent-session-details > summary');
  taskTrigger.classList.add('floating-new-task');
  taskTrigger.onclick=event=>{event.preventDefault();const add=document.querySelector('.new-task-button');if(add)add.click();const input=document.querySelector('.quick-task-row input');input?.scrollIntoView({block:'center'});input?.focus({preventScroll:true});};
  panel.querySelector('[data-cancel-registration]').onclick=()=>{panel.querySelector('.agent-session-details').open=false;};
  panel.querySelector('[name=taskId]').onchange = event => {
    panel.querySelector('[type=submit]').textContent = event.target.value ? 'Link session' : 'Create task';
    const title = panel.querySelector('[name=taskTitle]');
    title.required = !event.target.value;
    if (event.target.value && !title.value) title.value = doc.rows.find(row => row.id === event.target.value)?.taskTitle || event.target.value;
  };
  panel.querySelector('[data-copy-instruction]')?.addEventListener('click', async event => {
    const button = event.currentTarget, instruction = panel.querySelector('[data-agent-instruction]')?.value || '';
    try { await navigator.clipboard.writeText(instruction); button.textContent = 'Copied'; }
    catch { panel.querySelector('[data-agent-instruction]')?.select(); button.textContent = 'Select and copy'; }
  });
}

function createDocument(view, selected) { return inlineTreeFile({mode:'create', view, selected}); }

function inlineTreeFile({mode = 'create', view = 'docs', selected = null, doc = null} = {}) {
  const isRename = mode === 'rename';
  document.querySelectorAll('.tree-inline-file').forEach(row => row.remove());
  const projectFor = item => projectRoots.find(project => project.id === item?.projectId) || projectRoots.find(project => project.id === null) || projectRoots[0];
  const initialProject = projectFor(isRename ? doc : selected);
  const prefix = initialProject?.prefix || '';
  const relativePath = item => {
    const path = item?.path || '';
    const itemProject = projectFor(item);
    return path.slice(itemProject?.prefix?.length || 0);
  };
  const dirname = path => String(path || '').split('/').slice(0, -1).join('/');
  const currentRelativePath = relativePath(isRename ? doc : selected);
  const currentRoot = currentRelativePath.split('/')[0];
  const initialFolder = ['notes', 'letushv', 'inbox'].includes(currentRoot) ? dirname(currentRelativePath) : '';
  const defaultFolder = initialFolder || 'notes';
  const foldersFor = project => {
    const projectPrefix = project?.prefix || '';
    const folders = new Set(['']);
    for (const item of catalogue) {
      if (item.projectId !== project?.id) continue;
      const relative = item.path.slice(projectPrefix.length);
      const parts = relative.split('/'); parts.pop();
      for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'));
    }
    if (initialFolder && project?.id === initialProject?.id) folders.add(initialFolder);
    if (defaultFolder) folders.add(defaultFolder);
    return [...folders].sort((a, b) => !a ? -1 : !b ? 1 : a.localeCompare(b));
  };
  const projectValue = project => project?.id || '';
  const folderValue = (project, folder) => folder ? (project?.prefix || '') + folder : project?.prefix ? project.prefix.slice(0, -1) : '';
  const row = document.createElement('div');
  row.className = `tree-inline-file tree-inline-${isRename ? 'rename' : 'create'}`;
  row.dataset.inlineFile = mode;
  row.setAttribute('role', 'group');
  row.style.display = 'grid'; row.style.gap = '4px'; row.style.padding = '4px 8px 6px'; row.style.margin = '1px 0 2px';
  const compact = element => { element.style.width = '100%'; element.style.minWidth = '0'; element.style.padding = '5px 6px'; element.style.border = '1px solid var(--line-strong)'; element.style.borderRadius = '4px'; element.style.background = 'var(--surface)'; element.style.color = 'var(--ink)'; element.style.font = 'inherit'; element.style.fontSize = '12px'; };
  let projectSelect, folderSelect;
  if (!isRename) {
    const target = document.createElement('div'); target.style.display = 'grid'; target.style.gridTemplateColumns = 'minmax(0, 1fr) minmax(0, 1.15fr)'; target.style.gap = '4px';
    projectSelect = document.createElement('select'); projectSelect.setAttribute('aria-label', 'Проект'); projectSelect.title = 'Проект';
    projectSelect.innerHTML = projectRoots.map(project => `<option value="${esc(projectValue(project))}">${esc(project.name)}</option>`).join(''); compact(projectSelect); target.append(projectSelect);
    folderSelect = document.createElement('select'); folderSelect.setAttribute('aria-label', 'Папка'); folderSelect.title = 'Папка'; compact(folderSelect); target.append(folderSelect);
    row.append(target);
  }
  const nameInput = document.createElement('input'); nameInput.type = 'text'; nameInput.autocomplete = 'off'; nameInput.spellcheck = false; nameInput.placeholder = 'Имя файла'; nameInput.setAttribute('aria-label', isRename ? 'Новое имя файла' : 'Имя нового файла'); nameInput.enterKeyHint = 'done';
  if (isRename) {
    const currentName = relativePath(doc).split('/').at(-1) || doc?.title || '';
    nameInput.value = currentName.replace(/\.md$/i, '');
  }
  compact(nameInput); row.append(nameInput);
  const errorNode = document.createElement('span'); errorNode.className = 'save-status tree-inline-error'; errorNode.setAttribute('role', 'status'); errorNode.setAttribute('aria-live', 'polite'); errorNode.hidden = true; errorNode.style.fontSize = '11px'; errorNode.style.lineHeight = '1.35'; row.append(errorNode);
  const showError = message => { errorNode.textContent = message || ''; errorNode.hidden = !message; errorNode.classList.toggle('error', Boolean(message)); };
  const panel = inlinePanel(isRename ? 'Переименовать документ' : 'Новый документ', '');
  panel.append(row);
  const controls = document.createElement('div'); controls.className = 'inline-actions';
  controls.innerHTML = `<button class="button" data-cancel>Отмена</button><button class="button primary" data-save>${isRename ? 'Переименовать' : 'Создать'}</button>`;
  panel.append(controls);
  const restore = () => { if (panel.dataset.busy !== 'true') panel.close(); };
  controls.querySelector('[data-cancel]').onclick = restore;
  let saving = false;
  const cleanName = value => String(value ?? '').trim().replace(/\.md$/i, '').trim();
  const validateName = value => {
    const name = cleanName(value);
    if (!name) return 'Укажите имя файла.';
    if (name.length > 255 || new TextEncoder().encode(name).byteLength > 255) return 'Имя файла слишком длинное.';
    if (name === '.' || name === '..' || name.startsWith('.') || /[\\/\0\u0000-\u001f\u007f]/.test(name)) return 'Недопустимое имя файла.';
    return '';
  };
  const updateFolders = preferred => {
    if (isRename || !folderSelect) return;
    const project = projectRoots.find(item => projectValue(item) === projectSelect.value) || projectRoots[0];
    if (!project) { folderSelect.replaceChildren(); return; }
    const options = foldersFor(project);
    folderSelect.innerHTML = options.map(folder => `<option value="${esc(folderValue(project, folder))}">${esc(folder ? project.name + ' / ' + folder : project.name)}</option>`).join('');
    const preferredValue = folderValue(project, preferred || '');
    folderSelect.value = options.some(folder => folderValue(project, folder) === preferredValue) ? preferredValue : folderValue(project, '');
  };
  if (!isRename) {
    projectSelect.value = projectValue(initialProject);
    updateFolders(defaultFolder);
    projectSelect.onchange = () => { showError(''); updateFolders(defaultFolder); };
    folderSelect.onchange = () => showError('');
  }
  const save = async () => {
    if (saving) return;
    const nameError = validateName(nameInput.value); if (nameError) { showError(nameError); nameInput.focus(); return; }
    const name = cleanName(nameInput.value); let destination;
    if (isRename) {
      const relative = relativePath(doc), folder = dirname(relative); destination = prefix + (folder ? folder + '/' : '') + name + '.md';
      if (destination === doc.path) { restore(); return; }
    } else {
      const project = projectRoots.find(item => projectValue(item) === projectSelect.value) || projectRoots[0];
      if (!project) { showError('Выберите проект.'); return; }
      destination = (folderSelect.value ? folderSelect.value + '/' : '') + name + '.md';
    }
    saving = true; panel.dataset.busy = 'true'; controls.querySelector('[data-save]').disabled = true; row.querySelectorAll('input, select').forEach(element => { element.disabled = true; }); showError('');
    try {
      if (isRename) {
        const fresh = await settled(doc.path);
        const saved = await api('/api/rename', {path:doc.path, revision:fresh.revision, destination});
        documentSessions.delete(doc.path); panel.close(); location.hash = '#docs?' + encodeURIComponent(saved.path); toast('Документ переименован');
      } else {
        if (selected?.path) await settled(selected.path);
        const created = await api('/api/create', {path:destination, content:'# ' + name + '\n\n'});
        panel.close(); location.hash = '#docs?' + encodeURIComponent(created.path); toast('Документ создан');
      }
    } catch (error) { showError(error.message); row.querySelectorAll('input, select').forEach(element => { element.disabled = false; }); saving = false; panel.dataset.busy = 'false'; controls.querySelector('[data-save]').disabled = false; nameInput.focus(); }
  };
  controls.querySelector('[data-save]').onclick = save;
  row.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); if (!saving) restore(); return; }
    if (event.key === 'Enter' && event.target === nameInput) { event.preventDefault(); save(); }
  };
  nameInput.oninput = () => showError('');
  nameInput.focus(); if (isRename) nameInput.select();
  return row;
}

function importDestinations(selected) {
  const options = [];
  for (const project of projectRoots) {
    const projectPrefix = project.id ? `projects/${project.id}/` : '';
    const rootValue = project.id ? `projects/${project.id}` : '';
    const folders = new Set();
    for (const doc of catalogue.filter(item => item.projectId === project.id)) {
      const relative = doc.path.slice(projectPrefix.length).split('/');
      relative.pop();
      for (let index = 1; index <= relative.length; index++) folders.add(relative.slice(0, index).join('/'));
    }
    options.push({value:rootValue, label:project.name});
    [...folders].sort((a, b) => a.localeCompare(b)).forEach(folder => options.push({value:projectPrefix + folder, label:`${project.name} / ${folder}`}));
  }
  const selectedFolder = selected?.path?.split('/').slice(0, -1).join('/') || '';
  const selectedValue = options.some(option => option.value === selectedFolder) ? selectedFolder : options[0]?.value || '';
  return {options, selectedValue};
}

function openImportPanel(selected) {
  const {options, selectedValue} = importDestinations(selected);
  const panel = inlinePanel('Добавить Markdown-файлы', `<form class="file-picker"><label class="form-field">Папка назначения<select name="destination">${options.map(option => `<option value="${esc(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label><label class="form-field">Файлы Markdown<input name="files" type="file" accept=".md,text/markdown" multiple></label><p class="inline-panel-note">Файлы будут скопированы в выбранную папку. Исходники останутся на месте.</p><p class="file-picker-summary" data-file-summary>Выберите один или несколько файлов .md.</p><p class="save-status" data-import-status role="status"></p><div class="inline-actions"><button type="button" class="button" data-cancel>Отмена</button><button class="button primary" type="submit">Добавить файлы</button></div></form>`, $('.document-main') || main, 'file-picker-panel');
  const form = panel.querySelector('form');
  const input = form.querySelector('input[type=file]');
  const summary = panel.querySelector('[data-file-summary]');
  input.onchange = () => {
    const files = [...input.files];
    summary.textContent = files.length ? files.map(file => file.name).join(', ') : 'Выберите один или несколько файлов .md.';
  };
  panel.querySelector('[data-cancel]').onclick = () => { if (panel.dataset.busy !== 'true') panel.close(); };
  form.onsubmit = async event => {
    event.preventDefault();
    const files = [...input.files];
    if (!files.length) { status(panel.querySelector('[data-import-status]'), 'Выберите хотя бы один файл Markdown.', true); return; }
    if (files.some(file => !/\.md$/.test(file.name))) { status(panel.querySelector('[data-import-status]'), 'Можно добавлять только файлы с расширением .md (строчными буквами).', true); return; }
    const button = form.querySelector('[type=submit]'); button.disabled = true; panel.dataset.busy = 'true';
    try {
      const payload = [];
      let total = 0;
      for (const file of files) {
        const content = await file.text();
        const bytes = new TextEncoder().encode(content).byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error(`Файл «${file.name}» больше 2 МБ.`);
        total += bytes; if (total > 3 * 1024 * 1024) throw new Error('Общий размер выбранных файлов больше 3 МБ.');
        payload.push({name:file.name, content});
      }
      const result = await api('/api/import', {destination:form.elements.destination.value, files:payload});
      if (!result.documents?.length) throw new Error('Сервер не вернул добавленные документы.');
      panel.close();
      location.hash = '#docs?' + encodeURIComponent(result.documents[0].path);
      toast(`${result.documents.length} ${result.documents.length === 1 ? 'файл добавлен' : 'файла добавлено'}`);
    } catch (error) {
      status(panel.querySelector('[data-import-status]'), error.message, true);
      button.disabled = false;
    } finally { panel.dataset.busy = 'false'; }
  };
  return panel;
}

async function settled(docPath) { const source = documentSessions.get(docPath); if (source && !await source.flush()) throw new Error('Сначала сохраните Markdown или разрешите конфликт версий.'); return read(docPath); }

function documentActions(root, doc, current = 'visual') {
  root.commentsCleanup?.();root.commentsCleanup=null;root.addDocumentComment=null;root.dataset.editorMode=current;root.classList.toggle('prose-surface',current==='visual'&&!doc.reviewSchema);
  const bar = document.createElement('div'); bar.className = 'document-chrome';
  bar.innerHTML = `<span class="save-status" role="status" id="visual-status"></span><details class="file-menu"><summary aria-label="Меню документа">⋯</summary><div class="file-menu-items"><button data-file="visual">Вернуться к документу</button><button data-file="reading">Чтение</button><button data-file="copy-link">Скопировать ссылку</button><button data-file="copy-markdown">Скопировать Markdown</button><button data-file="history">История изменений</button><button data-file="source">Исходник Markdown</button><button data-file="retry" hidden>Повторить сохранение</button></div></details>`;
  const back = document.createElement('button'); back.id = 'app-back'; back.className = 'icon-button document-back'; back.setAttribute('aria-label', 'Назад'); back.textContent = navigationIndex === 0 ? '← Документы' : '← Назад'; back.onclick = () => navigationIndex === 0 ? location.hash = '#docs' : history.back(); bar.prepend(back);
  const breadcrumb=document.createElement('span');breadcrumb.className='document-path';breadcrumb.textContent=(doc.projectName||'Horizon')+' / '+doc.path.replace(/^projects\/[^/]+\//,'').replace(/\.(md|html)$/i,'').split('/').map(documentFolderName).join(' / ');bar.prepend(breadcrumb);bar.querySelector('[data-file=reading]').hidden=!doc.reviewSchema||current==='reading';bar.querySelector('[data-file=visual]').hidden=current==='visual';bar.querySelector('[data-file=source]').hidden=current==='source';
  root.prepend(bar);const mobile=document.createElement('div');mobile.className='document-mobile-head';mobile.innerHTML='<span aria-hidden="true" class="mobile-tree-space"></span><strong>'+esc(doc.projectName||'Horizon')+'</strong><details class="mobile-document-navigation"><summary aria-label="Разделы Horizon">⋯</summary><nav><a href="#inbox">Заметки</a><a href="#agents">Агенты</a><a href="#docs">Документы</a><button data-mobile-document>Действия документа</button><button data-mobile-theme>Сменить тему</button></nav></details>';mobile.querySelector('[data-mobile-theme]').onclick=()=>{document.querySelector('#theme-toggle')?.click();mobile.querySelector('details').open=false;};mobile.querySelector('[data-mobile-document]').onclick=()=>{bar.querySelector('details').open=!bar.querySelector('details').open;mobile.querySelector('details').open=false;};root.prepend(mobile);renderDocumentTabs(root,doc); bar.addEventListener('click', event => { if (event.target.closest('button')) bar.querySelector('details').open = false; });
  bar.querySelector('[data-file=visual]').onclick = async () => { try {const state=savedDocumentView(doc.path)||{};state.mode='visual';documentViewMemory.set(doc.path,state); history.replaceState(history.state,'',location.pathname+location.hash); renderVisual(documentSessions.get(doc.path)?.doc || doc); } catch (error) { toast(error.message); } };
  bar.querySelector('[data-file=source]').onclick = async () => { try { renderDocumentEditor(documentSessions.get(doc.path)?.doc || doc, 'source'); } catch (error) { toast(error.message); } };
  bar.querySelector('[data-file=reading]').onclick = async () => { try { renderReading(await settled(doc.path)); } catch (error) { toast(error.message); } };
  const documentURL = (quote, revision) => { const url = new URL(location.href); url.search = ''; url.hash = '#docs?' + encodeURIComponent(doc.path); if (quote) { url.searchParams.set('quote',quote); url.searchParams.set('quote-path',doc.path); url.searchParams.set('revision',revision); } return url.href; };
  for (const action of ['copy-link','copy-markdown']) {
    const button = bar.querySelector('[data-file=' + action + ']');
    button.onclick = async () => { try {
      const fresh = await settled(doc.path);
      await navigator.clipboard.writeText(action === 'copy-link' ? documentURL() : fresh.content); toast('Скопировано');
    } catch (error) { toast(error.message); } };
  }
  const agentCopy=document.createElement('button');agentCopy.dataset.file='agent-copy';agentCopy.textContent='Скопировать для агента';agentCopy.onclick=async()=>{try{await settled(doc.path);const result=await api('/api/annotations/export?path='+encodeURIComponent(doc.path));await navigator.clipboard.writeText(result.text);toast('Документ и комментарии скопированы');}catch(e){toast(e.message);}};bar.querySelector('.file-menu-items').append(agentCopy);bar.querySelector('[data-file=history]').before(agentCopy);
  const quickLink=bar.querySelector('[data-file=copy-link]');quickLink.className='text-button';bar.insertBefore(quickLink,bar.querySelector('.file-menu'));
  const commands=document.createElement('div');commands.className='document-commands';commands.append(quickLink,bar.querySelector('#visual-status'),bar.querySelector('.file-menu'));bar.append(commands);
  bar.querySelector('[data-file=history]').onclick = () => historyPanel(doc);
  bar.querySelector('[data-file=retry]').onclick = () => { const session = documentSessions.get(doc.path); if (session) { if (session.error?.status !== 409) session.error = null; session.flush(); } };
}

function showRestore() {
  const item = localStorage.getItem('horizon:last-trash'); const sidebar = $('.sidebar');sidebar?.querySelector('[data-restore]')?.remove();if (!item || !sidebar) return;
  const button = document.createElement('button'); button.className = 'icon-button'; button.dataset.restore = 'true'; button.title = 'Восстановить удалённое'; button.setAttribute('aria-label', button.title); button.className='text-button';button.textContent='↶ Восстановить удалённое'; sidebar.append(button);
  button.onclick=async()=>{try{await restoreTreeItem(JSON.parse(item));}catch(e){toast(e.message);}};
}

const documentSessions = new Map();
// Merge independent review cells by stable row ID; ambiguous edits stay as a draft.
function mergeReviewDraft(base, local, remote) {
  if(local===base||local===remote)return remote;
  if(remote===base)return local;
  const conflict=()=>{throw Object.assign(new Error('Одна ячейка или структура документа изменены одновременно. Черновик сохранён; сравните версии.'),{status:409});};
  const lines=text=>text.split('\n');
  const row=line=>{
    const cells=splitCells(line),id=cells[line.trimStart().startsWith('|')?1:0]?.trim().match(/^([RT]\d+)\b/)?.[1];
    return id&&cells.length>=4?{id,cells}:null;
  };
  const before=lines(base),draftLines=lines(local),result=lines(remote);
  if(before.length!==draftLines.length)conflict();
  const remoteRows=new Map();
  result.forEach((line,index)=>{const r=row(line);if(r){if(remoteRows.has(r.id))conflict();remoteRows.set(r.id,{...r,index});}});
  const seen=new Set();
  for(let i=0;i<before.length;i++){
    if(before[i]===draftLines[i])continue;
    const old=row(before[i]),next=row(draftLines[i]);
    if(!old||!next||old.id!==next.id||seen.has(old.id))conflict();seen.add(old.id);
    const current=remoteRows.get(old.id);
    if(!current||old.cells.length!==next.cells.length||old.cells.length!==current.cells.length)conflict();
    for(let c=0;c<old.cells.length;c++){
      if(next.cells[c]===old.cells[c])continue;
      if(current.cells[c]!==old.cells[c]&&current.cells[c]!==next.cells[c])conflict();
      current.cells[c]=next.cells[c];
    }
    result[current.index]=current.cells.join('|');
  }
  return result.join('\n');
}
class DocumentSession {
  constructor(doc, prefix = 'source:') {
    this.doc=doc;this.prefix=prefix;const recovered=draft(prefix+doc.path);
    this.value=recovered?.content??doc.content;this.viewValue=this.value;
    this.revision=recovered?.revision||doc.revision;
    this.baseContent=recovered?.baseContent??(this.revision===doc.revision?doc.content:null);
    this.error=null;this.inflight=null;this.timer=null;this.notify=()=>{};this.merged=false;
  }
  draftPath(){return this.prefix+this.doc.path;}
  dirty(){return this.value!==this.doc.content||this.revision!==this.doc.revision;}
  stash(){keepDraft(this.draftPath(),{revision:this.revision,content:this.value,baseContent:this.baseContent});}
  set(value){
    try{this.value=mergeReviewDraft(this.viewValue,value,this.value);this.viewValue=value;}
    catch(error){this.value=value;this.viewValue=value;this.error=error;this.stash();return this.notify();}
    this.stash();this.notify();clearTimeout(this.timer);if(!this.error||this.error.network)this.timer=setTimeout(()=>this.flush(),this.error?5000:900);
  }
  async flush(){
    clearTimeout(this.timer);
    if(this.inflight){await this.inflight;return this.error?false:this.flush();}
    if(this.error?.network)this.error=null;
    if(this.error)return false;
    if(!this.dirty()){clearDraft(this.draftPath());return true;}
    this.inflight=(async()=>{
      try{
        for(let attempt=0;attempt<3;attempt++){
          if(this.revision!==this.doc.revision){
            if(this.baseContent===null){
              const {versions}=await api('/api/history?path='+encodeURIComponent(this.doc.path));
              const old=versions.find(v=>v.revision===this.revision);
              if(!old)throw Object.assign(new Error('Исходная версия черновика не найдена. Черновик сохранён; требуется сравнение.'),{status:409});
              this.baseContent=(await api('/api/version?path='+encodeURIComponent(this.doc.path)+'&id='+encodeURIComponent(old.id))).content;
            }
            this.value=mergeReviewDraft(this.baseContent,this.value,this.doc.content);
            this.baseContent=this.doc.content;this.revision=this.doc.revision;this.merged=true;this.stash();
          }
          const value=this.value;
          try{
            const saved=await api('/api/document',{path:this.doc.path,revision:this.revision,content:value});
            this.doc=saved;this.revision=saved.revision;this.baseContent=saved.content;
            if(this.dirty())this.stash();else{clearDraft(this.draftPath());if(this.prefix!=='source:')clearDraft(this.doc.path);}
            return;
          }catch(error){if(error.status!==409||attempt===2)throw error;this.doc=await read(this.doc.path);}
        }
      }catch(error){this.error=error;this.stash();if(error.network)this.timer=setTimeout(()=>this.flush(),5000);}
    })();
    this.notify();await this.inflight;this.inflight=null;this.notify();
    if(!this.error&&this.dirty())return this.flush();return !this.error;
  }
}

async function reloadSourceEditor(docPath, mode = 'source', force = false) {
  const session = documentSessions.get(docPath); if (session?.inflight) await session.inflight;
  const host = $('.document-main');
  if (!force && session && (session.dirty() || session.error)) { inlineConfirm(host, 'Загрузить версию с диска и удалить текущий черновик Markdown?', () => reloadSourceEditor(docPath, mode, true)); return; }
  try { const fresh=await read(docPath); if (session) clearTimeout(session.timer); documentSessions.delete(docPath); clearDraft('source:' + docPath); clearDraft(docPath); renderDocumentEditor(fresh, mode); } catch (error) { toast(error.message); }
}
function renderDocumentEditor(doc, mode = 'source') {
  let session = documentSessions.get(doc.path); if (!session || (!session.dirty() && !session.inflight && !session.error)) { session = new DocumentSession(doc); documentSessions.set(doc.path, session); }
  const root = $('.document-main'); root.innerHTML = `<div class="document-toolbar"><span class="filepath">${esc(doc.sourcePath || doc.path)}</span><span class="save-status" role="status" id="source-status"></span><button class="button" id="source-save">Сохранить</button><button class="button" id="source-reload">↻ С диска</button></div><div id="source-error" class="visual-error"></div><div class="document-workbench mode-${esc(mode)}"><div class="source-pane"><label class="sr-only" for="document-source">Markdown документа</label><textarea id="document-source" spellcheck="false"></textarea></div><article class="preview-pane markdown"></article></div>`;
  const input = $('#document-source'), preview = root.querySelector('.preview-pane'); session.viewValue=session.value; input.value = session.value; preview.innerHTML = md(session.value);prepareDocumentImages(preview,doc.path);
  session.notify = () => { if (!input.isConnected) return; root.querySelector('[data-file=retry]').hidden=!session.error||session.error.status===409; status($('#source-status'), session.error ? 'Не сохранено' : session.inflight ? 'Сохраняется…' : session.dirty() ? 'Есть изменения…' : 'Сохранено', Boolean(session.error)); $('#source-error').textContent = session.error?.message || ''; };
  input.oninput = () => { session.set(input.value); preview.innerHTML = md(input.value);prepareDocumentImages(preview,doc.path); };
  input.onblur = () => session.flush(); input.onkeydown = event => { if (!(event.metaKey || event.ctrlKey)) return; const key=event.key.toLowerCase(); if (key === 's') { event.preventDefault(); session.flush(); } if (['b','i'].includes(key)) { event.preventDefault(); const a=input.selectionStart,b=input.selectionEnd,mark=key==='b'?'**':'*'; input.setRangeText(mark+input.value.slice(a,b)+mark,a,b,'select'); input.oninput(); } };
  $('#source-save').onclick = () => { if (session.error?.status !== 409 && session.revision === session.doc.revision) session.error = null; session.flush(); };
  $('#source-reload').onclick = () => reloadSourceEditor(doc.path, mode);
  documentActions(root, doc, mode); session.notify(); if (session.dirty() && !session.error) { clearTimeout(session.timer); session.timer = setTimeout(() => session.flush(), 900); }
}

async function historyPanel(doc) {
  try {
    const current = await settled(doc.path); const {versions} = await api('/api/history?path=' + encodeURIComponent(doc.path));
    const panel = inlinePanel('История изменений', `<div class="history-workbench"><div class="history-list">${versions.length ? versions.map(version => `<button data-version="${esc(version.id)}">${esc(new Date(version.createdAt).toLocaleString('ru-RU'))}<small>${esc(({user:'Вы',agent:'Агент',external:'Изменение на диске',initial:'Первая сохранённая версия',restore:'Восстановление',unknown:'Источник неизвестен'})[version.actor] || version.actor)}</small></button>`).join('') : '<p class="empty">История пока пуста.</p>'}</div><section class="history-content">Выберите версию слева.</section></div>`, $('.document-main'), 'history-panel');
    let pick = 0;
    panel.querySelectorAll('[data-version]').forEach(button => button.onclick = async () => {
      const sequence = ++pick;
      try {
        const old = await api('/api/version?path=' + encodeURIComponent(doc.path) + '&id=' + encodeURIComponent(button.dataset.version)); if (sequence !== pick) return;
        panel.querySelectorAll('[data-version]').forEach(item => item.classList.toggle('selected', item === button)); const area = panel.querySelector('.history-content');
        area.innerHTML = comparison(current.content, old.content) + `<div class="history-actions">${current.rows?.length ? '<button class="button" data-scope="agent">Вернуть ответы агента</button>' : ''}<button class="button" data-scope="document">Восстановить весь документ</button></div><p class="save-status" role="status"></p>`;
        area.querySelectorAll('[data-scope]').forEach(restore => restore.onclick = async () => {
          const full = restore.dataset.scope === 'document';
          const run = async () => { restore.disabled = true; try { const saved = await api('/api/restore-version', {path:doc.path, revision:current.revision, id:old.id, scope:restore.dataset.scope}); documentSessions.delete(doc.path); panel.close(); renderVisual(saved); toast('Восстановлено новой версией'); } catch (error) { status(area.querySelector('.save-status'), error.message, true); restore.disabled = false; } };
          if (full) { inlineConfirm(panel, 'Восстановить весь документ, включая комментарии? Текущая версия останется в истории.', run); return; }
          await run();
        });
      } catch (error) { toast(error.message); }
    });
  } catch (error) { toast(error.message); }
}
function comparison(before, after) { return `<div class="change-comparison"><section class="change-before"><h3>Было</h3><div class="markdown">${md(before)}</div></section><section class="change-after"><h3>Стало</h3><div class="markdown">${md(after)}</div></section></div>`; }

window.addEventListener('pagehide',rememberDocumentView);window.addEventListener('beforeunload',rememberDocumentView);
document.addEventListener('visibilitychange', () => { if(document.hidden)rememberDocumentView();if (document.hidden) documentSessions.forEach(session => session.flush()); });
document.addEventListener('click', async event => {
  const link = event.target.closest('.markdown a, .review-agent a, .task-text a, .task-note a, .daily-note-content a, .column-note a'); if (!link) return;
  const href = link.getAttribute('href'); if (!href) return;
  if(/^#(?:docs|agents|inbox)(?:[?]|$)/.test(href)||link.closest('[data-planner-path]') && href.startsWith('#')) return;
  if (/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(href)) return;
  if (/^https?:\/\//i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; return; }
  event.preventDefault(); const current = link.closest('[data-planner-path]')?.dataset.plannerPath || activeDoc?.path || 'planner/day.md'; const relative = href; const target=HorizonEditor.documentLink(current,relative);if(!target)return toast('Ссылка выходит за пределы проекта.');const normalized=target.path; let found = catalogue.find(doc => doc.sourcePath === href || doc.path === relative || doc.path === normalized);
  if (!found) { try { await refreshCatalogue(); found = catalogue.find(doc => doc.sourcePath === href || doc.path === relative || doc.path === normalized); } catch (error) { toast(error.message); return; } }
  if (found) {if(found.path===activeDoc?.path&&target.heading){history.pushState(null,'',documentRoute(found.path,target.heading));revealDocumentHeading(target.heading);}else location.hash=documentRoute(found.path,target.heading);} else toast('Этот файл или ссылка пока не подключены к просмотрщику.');
});
$('#global-search').onclick = () => { if ($('#search')) { setTreeHidden(false); $('#search').focus(); $('#search').scrollIntoView({block:'nearest'}); } else { searchRequested = true; location.hash = '#docs'; } };
let navigationIndex = 0;
history.replaceState({...history.state, horizonIndex:0}, '');

const setTreeHidden = hidden => { document.body.classList.toggle('tree-hidden', hidden); $('#toggle-tree').setAttribute('aria-expanded', String(!hidden)); $('#toggle-tree').setAttribute('aria-label', hidden ? 'Показать дерево документов' : 'Скрыть дерево документов'); };
setTreeHidden(localStorage.getItem('horizon:tree-hidden') === 'true');
$('#toggle-tree').onclick = () => { const hidden = !document.body.classList.contains('tree-hidden'); setTreeHidden(hidden); localStorage.setItem('horizon:tree-hidden', String(hidden)); };
document.querySelectorAll('.bottom-tabs a').forEach(link=>link.addEventListener('click',()=>{history.replaceState(history.state,'',location.pathname+location.hash);}));
window.addEventListener('hashchange', () => { if (Number.isInteger(history.state?.horizonIndex)) navigationIndex = history.state.horizonIndex; else { navigationIndex += 1; history.replaceState({...history.state, horizonIndex:navigationIndex}, ''); } if ($('#app-back') && !$('#app-back').classList.contains('document-back')) $('#app-back').disabled = navigationIndex === 0; renderRoute(); });
renderRoute();

let pendingInboxResult = null, inboxSnapshot = null, inboxPolling = false, inboxFilter = 'unread';
async function pollAgentInbox() {
  if (inboxPolling) return;
  inboxPolling = true;
  try {
    const data = await api('/api/agent-inbox?all=1');
    inboxSnapshot = data;
    let badge = document.querySelector('.inbox-badge');
    if (!badge) { badge = document.createElement('span'); badge.className = 'inbox-badge'; document.querySelector('[data-nav="agents"]').append(badge); }
    badge.textContent = data.count; badge.hidden = !data.count;
    document.querySelector('[data-nav="agents"]').setAttribute('aria-label', `Agents · ${data.count} new results`);
    paintAgentResults(data);
    if (main.dataset.inboxHome === 'true') paintInboxResults(data);
    return data;
  } catch (error) { if (main.dataset.inboxHome === 'true') { const status = document.querySelector('#inbox-status'); if (status) status.textContent = 'Не удалось обновить ответы. Повторим автоматически.'; } }
  finally { inboxPolling = false; }
}
function paintInboxResults(data) {
  const list = document.querySelector('#agent-inbox-results'); if (!list) return;
  const signature = inboxFilter + JSON.stringify(data); if (list.dataset.signature === signature) return; list.dataset.signature = signature;
  document.querySelector('#inbox-status').textContent = data.count ? `${data.count} unread` : 'No unread results';
  list.replaceChildren();
  const resultTime = item => { const iso = item.updates.match(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})/); if (iso) return Date.parse(iso[0]); const local = item.updates.match(/(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2}))?/); return local ? Date.parse(`${local[3]}-${local[2]}-${local[1]}T${local[4] || '00'}:${local[5] || '00'}:00+04:00`) : 0; };
  for (const item of data.items.filter(item => inboxFilter === 'all' || item.unread).sort((a,b) => resultTime(b) - resultTime(a))) {
    const button = document.createElement('button'); button.className = 'inbox-result' + (item.unread ? ' unread' : '');
    button.innerHTML = `<span class="inbox-result-project">${esc(item.projectName)} · ${esc(item.id)}</span><strong>${esc(item.taskTitle.replace(/^.*? · /, '').replace(/ — (Codex|Claude|Other).*$/i, ''))}</strong><span class="inbox-result-update">${md(item.updates)}</span><span class="inbox-open">${item.unread ? 'Unread · ' : ''}Open →</span>`;
    const stamp = item.updates.match(/\b(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|\d{2}\.\d{2}\.\d{4}(?:,? \d{2}:\d{2}(?: Самара)?)?)/)?.[0];
    button.querySelectorAll('.inbox-result-update a').forEach(link => link.replaceWith(document.createTextNode(link.textContent)));
    if (stamp) { button.querySelector('.inbox-result-update').innerHTML = button.querySelector('.inbox-result-update').innerHTML.replace(stamp, ''); const age = document.createElement('span'); age.className = 'inbox-age'; age.title = stamp; age.textContent = ' · ' + relativeStamp(stamp); button.querySelector('.inbox-result-project').append(age); }
    button.onclick = () => { pendingInboxResult = item; location.hash = '#docs?' + encodeURIComponent(item.path); };
    list.append(button);
  }
}
async function renderInbox(version) {
  if(version!==routeVersion)return;
  delete main.dataset.documentView;delete main.dataset.inboxHome;activeDoc=null;
  main.innerHTML='<section class="personal-inbox"><h1>Inbox</h1><p class="muted">Твои заметки и мысли по проектам</p><div class="personal-projects"></div></section>';
  const host=main.querySelector('.personal-projects');
  for(const project of projectRoots){
    const section=document.createElement('section');section.className='personal-project';const h=document.createElement('h2');h.textContent=project.name;section.append(h);
    const prefix=project.prefix||'',files=catalogue.filter(doc=>doc.projectId===project.id&&(doc.path.slice(prefix.length).startsWith('notes/')||doc.path.slice(prefix.length).startsWith('letushv/')||(!project.id&&doc.path.startsWith('inbox/'))));
    files.sort((a,b)=>Number(!a.path.endsWith('/inbox.md'))-Number(!b.path.endsWith('/inbox.md'))||a.title.localeCompare(b.title));
    for(const doc of files){const link=document.createElement('a');link.href='#inbox?'+encodeURIComponent(doc.path);link.textContent=doc.title;section.append(link);}
    if(!files.length){const empty=document.createElement('p');empty.textContent='Пока нет заметок';section.append(empty);}
    const add=document.createElement('button');add.className='text-button';add.textContent='+ New note';add.onclick=()=>createDocument('docs',{path:prefix+'notes/inbox.md',projectId:project.id});section.append(add);host.append(section);
  }
}
const resultReadPending=new Set();
async function markClickedResultRead(row){
  const item=row.horizonUnreadResult;if(!item)return;
  const key=item.id+':'+item.version;if(resultReadPending.has(key))return;
  resultReadPending.add(key);
  try{
    await api('/api/agent-inbox/read',{id:item.id,version:item.version});
    if(row.horizonUnreadResult?.version===item.version){row.horizonUnreadResult=null;row.classList.remove('agent-result-new');}
    await pollAgentInbox();
  }catch(error){toast(error.message);}finally{resultReadPending.delete(key);}
}
function paintAgentResults(data) {
  if(activeDoc?.path!=='reviews/agent-overview.md')return;
  document.querySelectorAll('tr[data-task-id]').forEach(row=>{
    const item=data.items.find(item=>item.id===row.dataset.taskId);
    row.classList.toggle('agent-result-new',Boolean(item?.unread));
    const session=documentSessions.get(activeDoc.path),known=(session?.doc||activeDoc).rows?.find(r=>r.id===item?.id);
    const progress=row.querySelector('.row-dispatch [role=status]');
    if(progress&&item?.commentState&&!session?.dirty()&&known?.comment===item.comment)progress.textContent=item.commentState;
    row.horizonUnreadResult=item?.unread?item:null;
    if(!row.dataset.readClickBound){row.dataset.readClickBound='true';row.addEventListener('click',()=>markClickedResultRead(row));}
  });
}

async function revealInboxResult() {
  if (!document.querySelector('.inbox-home')) delete main.dataset.inboxHome;
  const item = pendingInboxResult;
  if (!item || activeDoc?.path !== item.path) return;
  const row = [...document.querySelectorAll('[data-task-id]')].find(row => row.dataset.taskId === item.id);
  if (!row) return;
  const shown = activeDoc.rows?.find(row => row.id === item.id);
  if (documentSessions.get(item.path)?.dirty() || shown?.updates !== item.updates) { pendingInboxResult = null; return; }
  pendingInboxResult = null;
  for (let parent = row.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  row.scrollIntoView({block:'center'}); row.classList.add('inbox-target');
  if (!item.unread) return;
  try { await api('/api/agent-inbox/read', {id:item.id, version:item.version}); await pollAgentInbox(); }
  catch { toast('Есть более свежий результат — он остался непрочитанным.'); }
}
setInterval(pollAgentInbox, 5000);
pollAgentInbox();
