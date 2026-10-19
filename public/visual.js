/* Edit one Markdown block or cell at a time; untouched source remains byte-for-byte. */
const markdownWriter = new TurndownService({headingStyle:'atx', codeBlockStyle:'fenced', bulletListMarker:'-', emDelimiter:'*'});
markdownWriter.use(turndownPluginGfm.gfm);
markdownWriter.keep(['u']);
markdownWriter.addRule('portableImage',{filter:'img',replacement:(_content,node)=>'!['+(node.getAttribute('alt')||'').replace(/[\[\]\\]/g,'')+'](<'+(node.getAttribute('data-original-src')||node.getAttribute('src')||'')+'>)'});
markdownWriter.addRule('timestamp', {filter: node => node.nodeName === 'SPAN' && node.hasAttribute('data-original-date'), replacement: (_content, node) => node.getAttribute('data-original-date')});
markdownWriter.addRule('lineBreak', {filter:'br', replacement:() => '<br>'});
const cleanHtml = html => DOMPurify.sanitize(html, {FORBID_TAGS:['script','style','form','iframe','button','textarea'], FORBID_ATTR:['style']});
const cellEncode = text => text.replace(/[&<>|\\\r\n]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','|':'&#124;','\\':'&#92;','\r':'&#13;','\n':'<br>'})[character]).replace(/^ +| +$/g, spaces => '&#32;'.repeat(spaces.length));
function splitCells(line) { const parts = []; let start = 0, slashes = 0; for (let index = 0; index < line.length; index += 1) { if (line[index] === '|' && slashes % 2 === 0) { parts.push(line.slice(start, index)); start = index + 1; } slashes = line[index] === '\\' ? slashes + 1 : 0; } parts.push(line.slice(start)); return parts; }
function sourcePieces(content) {
  // marked normalizes all line endings. Map its offsets back to original bytes
  // instead of searching for normalized whitespace later in a mixed file.
  const tokens = marked.lexer(content), pieces = [], offsets=[0];let normalized='',cursor=0,tokenCursor=0;
  for(let index=0;index<content.length;index++){let character=content[index];if(character==='\r'){character='\n';if(content[index+1]==='\n')index++;}normalized+=character;offsets.push(index+1);}
  for (const token of tokens) { const at=normalized.indexOf(token.raw,tokenCursor);if(at<0)continue;const start=offsets[at],end=offsets[at+token.raw.length];if(start>cursor)pieces.push({raw:content.slice(cursor,start)});pieces.push({raw:content.slice(start,end),token,links:tokens.links});cursor=end;tokenCursor=at+token.raw.length; }
  if (cursor < content.length) pieces.push({raw:content.slice(cursor)}); return pieces;
}
function writable(element, label, onchange, session, {plain = false, cell = false} = {}) {
  element.contentEditable = plain ? 'plaintext-only' : 'true'; element.setAttribute('role', 'textbox'); element.setAttribute('aria-label', label); element.setAttribute('aria-multiline', 'true'); element.spellcheck = false;
  element.addEventListener('input',()=>followCaret(element));element.addEventListener('keyup',()=>followCaret(element));
  let composing = false;
  element.addEventListener('compositionstart', () => composing = true);
  element.addEventListener('compositionend', () => { composing = false; onchange(); });
  element.addEventListener('input', event => { if (!composing&&!event.target.closest('[data-comment-ui]')) onchange(); });
  element.addEventListener('blur', () => { if (!composing) session.flush(); });
  element.addEventListener('paste', event => { if(event.target.closest('[data-comment-ui]'))return;const files=[...event.clipboardData.files].filter(f=>f.type.startsWith('image/'));if(files.length&&element.dataset.imageDocument){event.preventDefault();insertDocumentImages(element,files,element.dataset.imageDocument);return;}event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
  element.addEventListener('keydown', event => {
    if(event.target.closest('[data-comment-ui]'))return;
    if (!plain && (event.ctrlKey || event.metaKey) && ['b','i','u'].includes(event.key.toLowerCase())) { event.preventDefault(); document.execCommand({b:'bold',i:'italic',u:'underline'}[event.key.toLowerCase()]); onchange(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); session.flush(); }
    if (cell && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); document.execCommand('insertLineBreak'); }
    if (cell && (event.key === 'Backspace' || event.key === 'Delete')) { const selection = getSelection(); if (selection?.isCollapsed && !element.textContent) event.preventDefault(); }
  });
}
let visualGeneration = 0, visualPoll = null;
async function reloadVisual(docPath, force = false) {
  const session = documentSessions.get(docPath); if (session?.inflight) await session.inflight;
  const host = $('.document-main');
  if (!force && session && (session.dirty() || session.error)) { inlineConfirm(host, 'Загрузить версию с диска и удалить текущий черновик?', () => reloadVisual(docPath, true)); return; }
  try { const fresh=await read(docPath); if (session) clearTimeout(session.timer); documentSessions.delete(docPath); clearDraft('source:' + docPath); clearDraft(docPath); renderVisual(fresh); } catch (error) { toast(error.message); }
}
function renderVisual(doc) {
  if(doc.format==='html')return renderHtmlDocument(doc);
  if(savedDocumentView(doc.path)?.mode==='reading')return renderReading(doc);
  if(savedDocumentView(doc.path)?.mode==='source'){renderDocumentEditor(doc,'source');restoreDocumentView();return;}
  if (new URLSearchParams(location.search).get('quote-path') === doc.path) return renderReading(doc);
  if(textSelectionTools)textSelectionTools.hidden=true;
  $('.document-main')?.classList.toggle('agent-overview-view',doc.path==='reviews/agent-overview.md');
  const generation = ++visualGeneration; clearInterval(visualPoll); activeDoc = doc;
  let session = documentSessions.get(doc.path); if (!session || (!session.dirty() && !session.inflight && !session.error)) { session = new DocumentSession(doc); documentSessions.set(doc.path, session); }
  if(!doc.reviewSchema)return renderProseEditor(doc,session,generation);
  // Carry old comment drafts into the explicit user column without changing untouched cells.
  const legacy = draft(doc.path); const userIndex = Number.isInteger(doc.reviewSchema?.userColumnIndex) ? doc.reviewSchema.userColumnIndex : doc.reviewSchema?.version === 2 ? 3 : 2;
  if (legacy?.comments && !draft('source:' + doc.path)) {
    const lines = session.value.split('\n');
    for (const row of doc.rows || []) if (Object.hasOwn(legacy.comments, row.id)) { const parts = splitCells(lines[row.index] || ''); const offset = lines[row.index]?.trimStart().startsWith('|') ? 1 : 0; parts[userIndex + offset] = ' ' + (legacy.comments[row.id] ? cellEncode(legacy.comments[row.id]) : '**') + ' '; lines[row.index] = parts.join('|'); }
    session.value = lines.join('\n'); session.revision = legacy.revision; session.stash(); if (legacy.revision !== doc.revision) session.error = Object.assign(new Error('Есть комментарии из прежней версии. Черновик сохранён; сравните его с файлом на диске.'), {status:409});
  }
  session.viewValue=session.value;
  const pieces = sourcePieces(session.value), root = $('.document-main'); root.innerHTML = '<div class="document-update" hidden></div><div class="visual-error" role="status"></div><article class="visual-document markdown"></article>';
  documentActions(root, doc, 'visual'); const article = root.querySelector('article'); const commit = () => session.set(pieces.map(piece => piece.raw).join(''));
  session.notify = () => { if (generation !== visualGeneration || !article.isConnected) return; status(root.querySelector('#visual-status'), session.error ? 'Не сохранено' : session.inflight ? 'Сохраняется…' : session.dirty() ? 'Есть изменения…' : 'Сохранено', Boolean(session.error)); root.querySelector('.visual-error').textContent = session.error?.message || ''; };
  for (const piece of pieces) {
    const token = piece.token; if (!token || token.type === 'space') continue;
    if (doc.path === 'reviews/agent-overview.md' && token.type === 'paragraph' && token.text.startsWith('Horizon, Наука и Рэйти:')) continue;
    if (token.type === 'table') { renderEditableTable(piece, article, doc, session, commit); continue; }
    const block = document.createElement('div'); block.className = 'visual-block'; const array = [token]; array.links = piece.links; block.innerHTML = cleanHtml(marked.parser(array)); article.append(block);
    writable(block, token.type === 'heading' ? 'Заголовок документа' : 'Текст документа', () => { const raw = markdownWriter.turndown(cleanHtml(block.innerHTML)); const ending = piece.raw.match(/\s*$/)?.[0] || ''; piece.raw = raw + (ending.includes('\n') ? ending : '\n\n'); commit(); }, session);
  }
  article.querySelectorAll(':scope > .visual-block').forEach(block=>{if(!block.querySelector('h1'))attachParagraphLink(block,doc.path);});
  const heading = article.firstElementChild;
  if (heading?.classList.contains('visual-block') && heading.querySelector('h1')) { heading.classList.add('document-heading'); root.querySelector('.document-chrome').prepend(heading); }
  const tail = document.createElement('div'); tail.className = 'visual-block visual-tail'; tail.dataset.placeholder = 'Продолжить документ…'; article.append(tail); let tailPiece = null;
  writable(tail, 'Продолжить документ', () => { if (!tailPiece) { tailPiece = {raw:''}; pieces.push(tailPiece); } tailPiece.raw = '\n\n' + markdownWriter.turndown(cleanHtml(tail.innerHTML)) + '\n'; commit(); }, session);
  renderDispatchControls(doc,session,root);
  session.notify(); if (typeof renderAgentSessionPanel === 'function') renderAgentSessionPanel(doc); if (session.dirty() && !session.error) { clearTimeout(session.timer); session.timer = setTimeout(() => session.flush(), 900); }
  visualPoll = setInterval(async () => {
    if (generation !== visualGeneration || !article.isConnected || document.hidden || root.dataset.dispatching) return;
    article.querySelectorAll('[data-original-date]').forEach(node => { node.textContent = relativeStamp(node.dataset.originalDate); });
    try { const fresh = await read(doc.path); if (fresh.revision === session.revision && !session.merged) return; if (!session.dirty() && !session.inflight && !session.error && !root.contains(document.activeElement) && !root.querySelector('.inline-panel, .agent-session-details[open], .file-menu[open]')) { const y = window.scrollY; renderVisual(fresh); window.scrollTo({top:y}); return; } const banner = root.querySelector('.document-update'); banner.hidden = false; banner.innerHTML = session.merged && !session.dirty() && !session.error ? '<span>Изменения объединены и сохранены.</span><button class="text-button">Обновить отображение</button>' : '<span>На диске есть новая версия.</span><button class="text-button">Показать изменения</button>'; banner.querySelector('button').onclick = () => reloadVisual(doc.path); } catch {}
  }, 5000);
}
function renderHtmlDocument(doc) {
  ++visualGeneration;clearInterval(visualPoll);activeDoc=doc;
  if(textSelectionTools)textSelectionTools.hidden=true;
  const root=$('.document-main');root.classList.remove('agent-overview-view');
  root.innerHTML='<div class="document-meta html-document-meta">'+esc(documentMetadata(doc))+'</div>';
  documentActions(root,doc,'html');
  root.querySelector('#visual-status').textContent='HTML · чтение';
  for(const name of ['visual','reading','source','history','agent-copy'])root.querySelector('[data-file='+name+']').hidden=true;
  root.querySelector('[data-file=copy-markdown]').textContent='Скопировать HTML';
  const frame=document.createElement('iframe');frame.className='html-document-frame';frame.title=doc.title;
  frame.setAttribute('sandbox','allow-same-origin');frame.src='/document-preview/'+doc.path.split('/').map(encodeURIComponent).join('/');root.append(frame);frame.onload=()=>{try{const body=frame.contentDocument.body;for(const link of body.querySelectorAll('a[href]'))link.onclick=event=>{const target=HorizonEditor.documentLink(doc.path,link.getAttribute('href'));if(target&&/\.(md|html)$/.test(target.path)){event.preventDefault();location.hash=documentRoute(target.path,target.heading);}};for(const img of body.querySelectorAll('img'))img.onclick=()=>showDocumentImage(img);}catch{}};
}

function tableSchema(doc, bodyLines) {
  const provided = doc.reviewSchema;
  const firstIds = bodyLines.slice(2).map(source => source.parts[source.offset]?.trim().match(/^([RT]\d+)\b/)?.[1]).filter(Boolean);
  const v2 = provided?.version === 2 || firstIds.some(id => id.startsWith('T')) || bodyLines.some(source => source.parts.length - source.offset * 2 === 4);
  const columns = provided?.columns?.length ? provided.columns : (v2 ? [{key:'task', label:'Task / session', index:0, owner:'agent'}, {key:'summary', label:'Summary / purpose', index:1, owner:'agent'}, {key:'updates', label:'Latest updates / next action', index:2, owner:'agent'}, {key:'comment', label:'Letushv comments and decisions', index:3, owner:'user'}] : [{key:'theme', label:'Theme', index:0, owner:'agent'}, {key:'agent', label:'Agent comment', index:1, owner:'agent'}, {key:'comment', label:'Letushv comment', index:2, owner:'user'}]);
  const userColumnIndex = Number.isInteger(provided?.userColumnIndex) ? provided.userColumnIndex : v2 ? 3 : 2;
  const agentIndex = columns.findIndex(column => column.owner === 'agent' && (column.key === 'updates' || column.key === 'agent')); return {v2, columns, userColumnIndex, agentIndex:agentIndex >= 0 ? agentIndex : v2 ? 2 : 1, idPrefix:provided?.idPrefix || (v2 ? 'T' : 'R')};
}
function relativeStamp(raw) {
  const local = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:,? (\d{2}):(\d{2}))?/);
  const timestamp = local ? Date.parse(`${local[3]}-${local[2]}-${local[1]}T${local[4] || '00'}:${local[5] || '00'}:00+04:00`) : Date.parse(raw);
  if (!Number.isFinite(timestamp)) return raw;
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (local && !local[4]) return minutes < 1440 ? 'today' : `${Math.floor(minutes / 1440)}d`;
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}min` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
function logicalCell(source, column) { return source.parts[source.offset + column] || ''; }
function renderEditableTable(piece, parent, doc, session, commit) {
  const wrapper = document.createElement('div'); wrapper.className = 'review-scroll'; wrapper.innerHTML = md(piece.raw); parent.append(wrapper); const table = wrapper.querySelector('table'); if (!table) return; table.classList.add('editable-table');
  const rawLines = piece.raw.split('\n'); const bodyLines = rawLines.map((line, index) => ({line, index, parts:splitCells(line.replace(/\r$/, '')), offset:line.trimStart().startsWith('|') ? 1 : 0})).filter(source => source.line.includes('|') && source.line.trim());
  const schema = tableSchema(doc, bodyLines); const isReview = Boolean((doc.reviewSchema?.kind === 'legacy-review' || doc.reviewSchema?.kind === 'task-summary') || bodyLines.slice(2).some(source => /^[RT]\d+\b/.test(logicalCell(source, 0).trim())));
  if (isReview) table.classList.add('review-table');
  const update = (lineIndex, column, value) => { const lines = piece.raw.split('\n'), ending = lines[lineIndex].endsWith('\r') ? '\r' : ''; const parts = splitCells(lines[lineIndex].replace(/\r$/, '')); const offset = lines[lineIndex].trimStart().startsWith('|') ? 1 : 0; if (parts[offset + column] === undefined) return; parts[offset + column] = ' ' + value + ' '; lines[lineIndex] = parts.join('|') + ending; piece.raw = lines.join('\n'); commit(); };
  if (!isReview && bodyLines[0] && table.tHead?.rows[0]) [...table.tHead.rows[0].cells].forEach((th, column) => { const editor = document.createElement('div'); editor.innerHTML = th.innerHTML; th.replaceChildren(editor); writable(editor, 'Заголовок столбца ' + (column + 1), () => update(bodyLines[0].index, column, markdownWriter.turndown(cleanHtml(editor.innerHTML)).replace(/\|/g, '&#124;').replace(/\n/g, '<br>')), session, {cell:true}); });
  const closed = [], rows = [...(table.tBodies[0]?.rows || [])];
  rows.forEach((tr, index) => {
    const source = bodyLines[index + 2]; if (!source) return; const id = logicalCell(source, 0).trim().match(/^([RT]\d+)\b/)?.[1]; const row = id ? (doc.rows || []).find(candidate => candidate.id === id) : null;
    if (id) tr.dataset.taskId = id;
    [...tr.cells].forEach((td, column) => {
      const editor = document.createElement('div'); editor.className = row && column === schema.userColumnIndex ? 'review-comment' : row && column === schema.agentIndex ? 'review-agent' : row && column === 0 ? 'review-theme' : 'cell-editor'; editor.innerHTML = td.innerHTML; td.replaceChildren(editor);
      let titlePrefix = '', titleSuffix = '';
      if (row && column === 0) {
        const title = schema.v2 ? row.taskTitle || String(row.task || '').replace(/^T\d+\s*[·.:-]?\s*/, '') : row.theme.replace(/^R\d+\s*[·.:-]?\s*/, '');
        const sessionMatch = schema.v2 && title.match(/^(.*?) · (.*?) — (Codex|Claude|Other)(?: (.+))?$/i);
        editor.textContent = sessionMatch ? sessionMatch[2] : title;
        if (sessionMatch) { titlePrefix = sessionMatch[1] + ' · '; titleSuffix = ' — ' + sessionMatch[3] + (sessionMatch[4] ? ' ' + sessionMatch[4] : ''); }
        const meta = document.createElement('details'); meta.className = 'row-meta'; meta.open = true;
        meta.innerHTML = `<summary>${esc(sessionMatch ? sessionMatch[1] + ' · ' + sessionMatch[3] : id)} <span aria-hidden="true">⌄</span></summary><div class="session-details"><span>${esc(id)}</span>${sessionMatch?.[4] ? `<code>${esc(sessionMatch[4])}</code>` : ''}</div>`;
        td.append(meta);
        if (sessionMatch && sessionMatch[3].toLowerCase() === 'codex' && /^[0-9a-f-]{36}$/i.test(sessionMatch[4] || '')) { const link = document.createElement('a'); link.href = 'codex://threads/' + sessionMatch[4]; link.textContent = 'Open session'; link.className = 'session-link'; meta.querySelector('.session-details').append(link); }
      }
      if (row && column === 0 && row.overviewSessions?.length) {
        const container = td.querySelector('.session-details');
        if (container) {
          container.querySelectorAll('a.session-link').forEach(link => link.remove());
          for (const binding of row.overviewSessions) {
            const link = document.createElement(binding.provider === 'codex' && /^[0-9a-f-]{36}$/i.test(binding.sessionId || '') ? 'a' : 'span');
            if (link.tagName === 'A') link.href = 'codex://threads/' + binding.sessionId;
            link.className = 'session-link'; link.textContent = binding.provider + ' · ' + (row.overviewSessions.length > 1 ? binding.sessionId?.slice(0, 8) || 'Unlinked' : 'Open session');
            link.title = binding.sessionId || 'Session not linked'; container.append(link);
          }
        }
      }
      if (row && column === schema.agentIndex) {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) { const match = node.textContent.match(/\b(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})|\d{2}\.\d{2}\.\d{4}(?:,? \d{2}:\d{2}(?: Самара)?)?)/); if (!match) continue; const tail = node.splitText(match.index); tail.splitText(match[0].length); const date = document.createElement('span'); date.className = 'update-date'; date.dataset.originalDate = match[0]; date.title = match[0]; date.contentEditable = 'false'; date.textContent = relativeStamp(match[0]); tail.replaceWith(date); }
      }
      if (row && column === schema.userColumnIndex) { editor.innerHTML = cleanHtml(marked.parseInline((row.userComment ?? row.comment ?? '').replace(/\n/g,'<br>'))); editor.dataset.placeholder = 'Ваш комментарий…'; if (row.commentAcknowledged) { editor.classList.add('addressed'); const label = document.createElement('span'); label.className = 'comment-addressed-label'; label.textContent = 'Разобрано агентом · текст сохранён'; td.prepend(label); editor.addEventListener('input', () => { editor.classList.remove('addressed'); label.style.visibility = 'hidden'; }, {once:true}); } }
      const plain = Boolean(row && column === 0);
      writable(editor, row ? (column === schema.userColumnIndex ? 'Комментарий ' : column === schema.agentIndex ? 'Ответ агента ' : column === 0 ? 'Тема ' : 'Поле ') + id : 'Ячейка ' + (index + 1) + ' ' + (column + 1), () => {
        let value = plain ? cellEncode(editor.innerText) : markdownWriter.turndown(cleanHtml(editor.innerHTML)).replace(/\|/g, '&#124;').replace(/\n/g, '<br>');
        if (row && column === 0) value = id + ' · ' + titlePrefix + value + titleSuffix; if (row && column === schema.userColumnIndex && !value) value = '**'; update(source.index, column, value);
      }, session, {plain, cell:true});
    });
    if (row) {
      const close = document.createElement('button'); close.type = 'button'; close.className = 'row-close-action';
      close.textContent = row.status === 'closed' ? 'Reopen' : 'Close';
      close.setAttribute('aria-label', close.textContent + ' ' + row.id);
      close.onclick = async () => {
        close.disabled = true;
        try {
          if (!await session.flush()) throw new Error('Сначала сохраните изменения.');
          const fresh = await settled(doc.path);
          const saved = await api('/api/row-state', {path:doc.path, revision:fresh.revision, id:row.id, action:row.status === 'closed' ? 'working' : 'closed'});
          if (agentSessionResult?.taskId === row.id) agentSessionResult = null;
          renderVisual(saved);
        } catch (error) { toast(error.message); close.disabled = false; }
      };
      tr.cells[0].append(close);
      if (doc.path === 'reviews/agent-overview.md') {
        const copy=document.createElement('button');copy.type='button';copy.className='row-copy-brief';copy.textContent='⧉';copy.title='Copy task for agent';copy.setAttribute('aria-label','Copy task '+row.id);
        copy.onclick=async()=>{try{const fresh=await settled(doc.path),current=fresh.rows.find(item=>item.id===row.id);if(!current)throw new Error('Задача больше не найдена');const root=fresh.sourcePath.slice(0,-'reviews/agent-overview.md'.length);const instruction=`Task ${current.id}: ${current.taskTitle || current.task}.\nPurpose: ${current.summary || '—'}\nRead ${fresh.sourcePath} and ${root}skills/table-review/SKILL.md. Work on ${current.id}; read its latest user comments before acting. After each significant result update this row with a fresh revision using ${root}scripts/review-agent.mjs. Preserve the user comments exactly; lead updates with an English status.`;await navigator.clipboard.writeText(instruction);copy.textContent='✓';copy.title='Copied';}catch(error){toast(error.message);}};
        tr.cells[0].append(copy);
      }
    }
    if (row?.status === 'closed') closed.push(tr);
  });
  if (isReview) {
    const plus = document.createElement('tr'); plus.className = 'review-row-add'; plus.innerHTML = `<td colspan="${table.tHead?.rows[0]?.cells.length || schema.columns.length}"><button aria-label="Добавить тему в таблицу">＋</button></td>`; table.tBodies?.[0]?.append(plus);
    plus.querySelector('button').textContent = '＋ New task'; plus.querySelector('button').className = 'button new-task-button';
    plus.querySelector('button').onclick = () => { if (doc.path === 'reviews/agent-overview.md') {
      plus.innerHTML = `<td colspan="4"><form class="quick-task-row"><select aria-label="Project for new task">${projectRoots.map(p=>`<option value="${esc(p.id||'')}">${esc(p.name)}</option>`).join('')}</select><input aria-label="New task title" placeholder="New task… Enter to add" required><button type="button" class="button" data-cancel-task>Cancel</button><span role="status"></span></form></td>`;
      const form=plus.querySelector('form'),input=form.querySelector('input'), project=form.querySelector('select');
      form.querySelector('[data-cancel-task]').onclick=()=>renderVisual(session.doc);
      input.focus(); input.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();renderVisual(session.doc);}};
      form.onsubmit=async event=>{event.preventDefault();if(!input.value.trim())return;input.disabled=true;try{
        if(!await session.flush())throw new Error('Сначала сохраните изменения.');
        agentSessionResult=await api('/api/agent-session',{projectId:project.value||null,taskTitle:input.value.trim(),provider:'codex',mode:'create'});
        const projectValue=project.value; renderVisual(await read(doc.path));
        document.querySelector('[aria-label="Добавить тему в таблицу"]')?.click();
        const next=document.querySelector('.quick-task-row select');if(next)next.value=projectValue;
      }catch(error){form.querySelector('[role=status]').textContent=error.message;input.disabled=false;}};
      return;
    } plus.innerHTML = `<td><input class="inline-new-theme" aria-label="Новая тема" placeholder="Новая тема…"></td><td class="new-row-hint" colspan="${Math.max(1, schema.columns.length - 1)}">Enter — добавить</td>`; const input = plus.querySelector('input'); input.focus(); input.onkeydown = async event => { if (event.key === 'Escape') { renderVisual(session.doc); return; } if (event.key !== 'Enter' || !input.value.trim()) return; event.preventDefault(); input.disabled = true; try { if (!await session.flush()) throw new Error('Сначала сохраните текущие изменения.'); const fresh = await read(doc.path); const saved = await api('/api/row', {path:doc.path, revision:fresh.revision, theme:input.value.trim(), comment:''}); renderVisual(saved); const id = saved.rows?.at(-1)?.id; document.querySelector(`[aria-label="Комментарий ${id}"]`)?.focus(); } catch (error) { toast(error.message); input.disabled = false; } }; };
    if (closed.length) { const details = document.createElement('details'); details.className = 'closed-reviews'; details.innerHTML = `<summary>Закрытые · ${closed.length}</summary><div class="review-scroll"><table class="review-table editable-table"><thead>${table.tHead?.innerHTML || ''}</thead><tbody></tbody></table></div>`; parent.append(details); closed.forEach(row => details.querySelector('tbody').append(row)); }
    if (doc.path === 'reviews/agent-overview.md') {
      const groups = new Map();
      for (const tr of rows.filter(tr => !closed.includes(tr))) {
        const row = doc.rows.find(row => row.id === tr.dataset.taskId);
        const key = row?.overviewProjectName === 'Horizon' ? 'local' : row?.overviewProjectId ?? 'unassigned';
        if (!groups.has(key)) groups.set(key, {name:row?.overviewProjectName || 'Unassigned', rows:[]});
        groups.get(key).rows.push(tr);
      }
      for (const [key, group] of groups) {
        const details = document.createElement('details'); details.className = 'project-review-group';
        details.open = localStorage.getItem('horizon:review-group:' + key) !== 'false';
        details.innerHTML = `<summary>${esc(group.name)} <span>${group.rows.length}</span></summary><table class="review-table editable-table"><thead>${table.tHead?.innerHTML || ''}</thead><tbody></tbody></table>`;
        group.rows.forEach(tr => details.querySelector('tbody').append(tr));
        details.ontoggle = () => localStorage.setItem('horizon:review-group:' + key, String(details.open));
        wrapper.insertBefore(details, table);
      }
      table.tHead?.remove();
    }
  } else { const add = document.createElement('button'); add.className = 'generic-row-add'; add.textContent = '＋'; add.setAttribute('aria-label', 'Добавить строку таблицы'); wrapper.append(add); add.onclick = async () => { if (!await session.flush()) return; piece.raw = piece.raw.trimEnd() + '\n| ' + Array(table.tHead?.rows[0]?.cells.length || 1).fill(' ').join(' | ') + ' |\n'; commit(); if (await session.flush()) renderVisual(session.doc); }; }
}

async function rowStatusPanel(doc, id, session) {
  try { if (!await session.flush()) throw new Error('Сначала сохраните изменения.'); const panel = formInline('Status ' + id, '<label class="form-field">State<select name="status"><option value="working">In progress</option><option value="review">Needs review</option><option value="closed">Closed</option></select></label>', async data => { const fresh = await settled(doc.path); renderVisual(await api('/api/row-state', {path:doc.path, revision:fresh.revision, id, action:data.get('status')})); }, 'Apply', 'Closed rows remain in the document and can be reopened.'); panel.querySelector('select').value = session.doc.rows.find(row => row.id === id)?.status || 'working'; } catch (error) { toast(error.message); }
}
function comparisonValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return `<div class="agent-diff-fields">${['task','summary','updates'].filter(key => value[key] !== undefined).map(key => `<p><strong>${esc(key)}</strong>${md(value[key])}</p>`).join('')}</div>`;
  return md(typeof value === 'string' ? value : '');
}
function comparison(before, after) { return `<div class="change-comparison"><section class="change-before"><h3>Было</h3>${comparisonValue(before)}</section><section class="change-after"><h3>Стало</h3>${comparisonValue(after)}</section></div>`; }
async function rowChanges(doc, row, session) {
  try { if (!await session.flush()) throw new Error('Сначала сохраните изменения.'); const fresh = await read(doc.path), current = fresh.rows.find(candidate => candidate.id === row.id); if (!current) throw new Error('Строка изменилась. Обновите документ.'); const before = current.beforeAgentContent ?? current.beforeAgent; const after = current.agentContent ?? current.agent; const panel = inlinePanel('Updates ' + row.id, comparison(before, after) + '<div class="history-actions"><button class="button primary" data-seen>Mark as seen</button></div>', $('.document-main')); panel.querySelector('[data-seen]').onclick = async () => { try { const saved = await api('/api/row-state', {path:doc.path, revision:fresh.revision, id:row.id, action:'seen'}); panel.close(); renderVisual(saved); } catch (error) { toast(error.message); } }; } catch (error) { toast(error.message); }
}

function renderReading(doc) {
  clearInterval(visualPoll); activeDoc = doc;
  const root = $('.document-main'); root.innerHTML = '<article class="reading-document markdown"></article>';
  const article = root.querySelector('article'); article.innerHTML = md(doc.content);prepareDocumentImages(article,doc.path);
  documentActions(root, doc, 'reading');
  article.querySelectorAll(':scope > p, :scope > h2, :scope > h3, :scope > blockquote, :scope > pre, :scope > ul, :scope > ol').forEach(block=>attachParagraphLink(block,doc.path));
  const edit = root.querySelector('[data-file=visual]'); edit.textContent = 'Edit document';
  edit.onclick = async () => { try { const url = new URL(location.href); url.searchParams.delete('quote'); url.searchParams.delete('quote-path'); url.searchParams.delete('revision'); history.replaceState(history.state,'',url); renderVisual(await settled(doc.path)); } catch (error) { toast(error.message); } };
  const params = new URLSearchParams(location.search), quote = params.get('quote-path') === doc.path ? params.get('quote') : null;
  if (quote) {
    const nodes=[]; const walker=document.createTreeWalker(article,NodeFilter.SHOW_TEXT); let text='';
    while(walker.nextNode()){if(walker.currentNode.parentElement?.closest('button'))continue;nodes.push({node:walker.currentNode,start:text.length});text+=walker.currentNode.textContent;}
    let start=text.indexOf(quote), end=start+quote.length;
    if(start<0){let compact='',offsets=[];for(let i=0;i<text.length;i++){if(!/\s/.test(text[i])){compact+=text[i];offsets.push(i);}}const needle=quote.replace(/\s/g,''),at=needle?compact.indexOf(needle):-1;if(at>=0){start=offsets[at];end=offsets[at+needle.length-1]+1;}}
    const notice=document.createElement('p'); notice.className='quote-notice';
    notice.textContent=start<0?'Цитата изменилась или не найдена. Исходная цитата: '+quote:params.get('revision')!==doc.revision?'Документ изменился; цитата найдена в текущей версии.':'Цитата найдена.';
    article.before(notice);
    if(start>=0){const first=nodes.find(x=>x.start+x.node.length>start),last=nodes.find(x=>x.start+x.node.length>=end);if(first&&last){const range=document.createRange();range.setStart(first.node,start-first.start);range.setEnd(last.node,end-last.start);getSelection().removeAllRanges();getSelection().addRange(range);first.node.parentElement.scrollIntoView({block:'center'});}}
  }
}

let documentQuoteSelection = null;
document.addEventListener('selectionchange', () => {
  const selection=getSelection(), root=document.querySelector('.document-main');
  if (selection && !selection.isCollapsed && root?.contains(selection.anchorNode) && root.contains(selection.focusNode) && !selection.anchorNode.parentElement?.closest('.file-menu,.document-chrome')) {
    documentQuoteSelection={path:activeDoc?.path,text:selection.toString().trim()};
  }
});

// Native selection + existing Markdown editor; no second editor model.
let textSelectionTools = null, textSelectionRange = null;
function updateSelectionTools() {
  const selection=getSelection(), root=document.querySelector('.document-main')||document.querySelector('.review-workspace');
  const anchor=selection?.anchorNode?.nodeType===1?selection.anchorNode:selection?.anchorNode?.parentElement;
  if(!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim() || !root?.contains(selection.anchorNode) || !root.contains(selection.focusNode) || anchor?.closest('.file-menu,.agent-session-panel,[data-comment-ui]') || root.classList.contains('review-workspace')&&!anchor?.closest('.review-comment-editor')) {
    if(textSelectionTools && !textSelectionTools.contains(document.activeElement))textSelectionTools.hidden=true;
    return;
  }
  textSelectionRange=selection.getRangeAt(0).cloneRange();
  documentQuoteSelection={path:activeDoc?.path,text:selection.toString().trim()};
  if(!textSelectionTools){
    textSelectionTools=document.createElement('div');textSelectionTools.className='text-selection-tools';textSelectionTools.setAttribute('role','toolbar');textSelectionTools.setAttribute('aria-label','Форматирование выделения');
    textSelectionTools.innerHTML='<button type="button" data-format="bold" aria-label="Жирный" title="Жирный · ⌘B"><b>B</b></button><button type="button" data-format="italic" aria-label="Курсив" title="Курсив · ⌘I"><i>I</i></button><select aria-label="Стиль абзаца" data-block-style><option value="p">Текст</option><option value="h2">Заголовок</option><option value="h3">Подзаголовок</option></select><button type="button" data-add-document-comment>Комментарий</button><button type="button" data-copy-selected aria-label="Скопировать текст" title="Скопировать текст">⧉</button><button type="button" data-link-selected aria-label="Ссылка на цитату" title="Ссылка на цитату">Ссылка</button>';
    document.body.append(textSelectionTools);
    textSelectionTools.onmousedown=event=>event.preventDefault();
    textSelectionTools.querySelectorAll('[data-format]').forEach(button=>button.onclick=()=>{if(!textSelectionRange)return;const sel=getSelection();sel.removeAllRanges();sel.addRange(textSelectionRange);document.execCommand(button.dataset.format);});
    const blockStyle=textSelectionTools.querySelector('[data-block-style]');
    blockStyle.onmousedown=event=>event.stopPropagation();
    blockStyle.onchange=()=>{if(!textSelectionRange)return;const sel=getSelection();sel.removeAllRanges();sel.addRange(textSelectionRange);document.execCommand('formatBlock',false,blockStyle.value);};
    textSelectionTools.querySelector('[data-add-document-comment]').onclick=()=>document.querySelector('.document-main')?.addDocumentComment?.();
    textSelectionTools.querySelector('[data-copy-selected]').onclick=async()=>{try{await navigator.clipboard.writeText(documentQuoteSelection.text);toast('Текст скопирован');}catch(error){toast(error.message);}};
    textSelectionTools.querySelector('[data-link-selected]').onclick=async()=>{try{
      const selected={...documentQuoteSelection},fresh=await settled(selected.path),url=new URL(location.href);url.search='';url.hash='#docs?'+encodeURIComponent(selected.path);url.searchParams.set('quote',selected.text);url.searchParams.set('quote-path',selected.path);url.searchParams.set('revision',fresh.revision);await navigator.clipboard.writeText(url.href);toast('Ссылка на выделенный текст скопирована');
    }catch(error){toast(error.message);}};
  }
  const review=root.classList.contains('review-workspace');
  textSelectionTools.classList.toggle('document-comment-trigger',Boolean(root.addDocumentComment)||review);textSelectionTools.querySelector('[data-add-document-comment]').hidden=!root.addDocumentComment;
  const editable=anchor?.closest('[contenteditable="true"]');
  const blockStyle=textSelectionTools.querySelector('[data-block-style]');blockStyle.hidden=!editable?.matches('.visual-block,.review-comment-editor');blockStyle.disabled=!editable;
  const block=anchor?.closest('p,h1,h2,h3,h4,h5,h6');blockStyle.value=['h2','h3'].includes(block?.localName)?block.localName:'p';
  textSelectionTools.querySelectorAll('[data-format]').forEach(button=>{button.hidden=review&&!editable;button.disabled=!editable;button.title=editable?(button.dataset.format==='bold'?'Жирный · ⌘B':'Курсив · ⌘I'):'Открой документ для редактирования';});
  textSelectionTools.hidden=false;
  const rect=textSelectionRange.getBoundingClientRect(),width=textSelectionTools.offsetWidth;
  textSelectionTools.style.left=Math.max(8,Math.min(innerWidth-width-8,rect.left+(rect.width-width)/2))+'px';
  const height=textSelectionTools.offsetHeight;
  textSelectionTools.style.top=Math.max(8,Math.min(innerHeight-height-8,rect.top>height+8?rect.top-height-8:rect.bottom+8))+'px';
}
document.addEventListener('selectionchange',updateSelectionTools);
window.addEventListener('scroll',()=>{if(textSelectionTools)textSelectionTools.hidden=true;},{passive:true});

async function copyFragmentLink(docPath,text) {
  if(!text.trim())throw new Error('В абзаце пока нет текста');
  const fresh=await settled(docPath),url=new URL(location.href);url.search='';url.hash='#docs?'+encodeURIComponent(docPath);url.searchParams.set('quote',text.trim());url.searchParams.set('quote-path',docPath);url.searchParams.set('revision',fresh.revision);await navigator.clipboard.writeText(url.href);
}
function attachParagraphLink(block,docPath) {
  const shell=document.createElement('div');shell.className='paragraph-shell';block.replaceWith(shell);shell.append(block);
  const button=document.createElement('button');button.type='button';button.className='paragraph-link';button.textContent='¶↗';button.title='Copy paragraph link';button.setAttribute('aria-label','Copy paragraph link');
  button.onmousedown=event=>event.preventDefault();
  button.onclick=async()=>{try{await copyFragmentLink(docPath,block.innerText);toast('Ссылка на абзац скопирована');}catch(error){toast(error.message);}};
  shell.append(button);
}

function renderDispatchControls(doc,session,root) {
  if(doc.path!=='reviews/agent-overview.md')return;
  let sending=false;
  const controls=new Map();
  const bulk=document.createElement('div');bulk.className='bulk-dispatch';
  bulk.innerHTML='<button type="button" class="button primary" title="Send comments on all open tasks">Send all ↗</button><span role="status"></span>';
  root.querySelector('.document-chrome').append(bulk);
  const allButton=bulk.querySelector('button'),allStatus=bulk.querySelector('span');
  async function sendRows(ids) {
    if(sending)return;
    sending=true;root.dataset.dispatching='true';allButton.disabled=true;
    controls.forEach(control=>control.button.disabled=true);
    let queued=0,skipped=0,failed=0;const failures=[];
    allStatus.textContent='Sending…';
    try {
      if(!await session.flush())throw new Error('Сначала сохраните комментарий.');
      const fresh=await read(doc.path);
      const rows=fresh.rows.filter(row=>(!ids||ids.includes(row.id))&&row.status!=='closed');
      const candidates=rows.filter(row=>{
        if(row.commentAcknowledged||!row.comment?.trim()||['**','Ваш комментарий…'].includes(row.comment.trim()))return false;
        const text=document.createElement('div');text.innerHTML=cleanHtml(marked.parse(row.comment));
        text.querySelectorAll('del,s,strike').forEach(node=>node.remove());
        return Boolean(text.textContent.trim());
      });
      skipped=rows.length-candidates.length;
      for(let offset=0;offset<candidates.length;offset+=30){
        const tasks=(await api('/api/codex/preview',{ids:candidates.slice(offset,offset+30).map(row=>row.id)})).tasks;
        for(const task of tasks){
          const control=controls.get(task.id);
          try{
            if(task.error)throw new Error(task.error);
            if(control)control.status.textContent='Sending…';
            const result=await api('/api/codex/dispatch',{id:task.id,requestId:task.requestId});
            if(result.error)throw new Error(result.error);
            if(!['queued','sent','completed'].includes(result.state))throw new Error('Delivery not confirmed — check Codex.');
            if(control)control.status.textContent=({queued:'Queued in Codex',sent:'Sent',completed:'Completed'})[result.state];
            queued++;
          }catch(error){
            failed++;failures.push(task.id+': '+error.message);
            if(control){control.status.textContent=error.message;
              if(task.prompt&&!control.actions.querySelector('[data-copy]')){
                const copy=document.createElement('button');copy.type='button';copy.className='text-button';copy.dataset.copy='true';copy.textContent='Copy prompt';
                copy.onclick=async()=>{try{await navigator.clipboard.writeText(task.prompt);toast('Prompt copied');}catch(e){toast(e.message);}};
                const link=document.createElement('a');link.href='codex://threads/'+task.threadId;link.textContent='Open session';control.actions.append(copy,link);
              }
            }
          }
        }
      }
      if(ids&&!candidates.length){const control=controls.get(ids[0]);if(control)control.status.textContent='No new comment to send';}
      allStatus.textContent=`${queued} accepted${skipped?` · ${skipped} skipped`:''}${failed?` · ${failed} failed (${failures.join('; ')})`:''}`;
    }catch(error){allStatus.textContent=error.message;}
    finally{sending=false;delete root.dataset.dispatching;allButton.disabled=false;controls.forEach(control=>control.button.disabled=false);}
  }
  allButton.onclick=()=>sendRows();
  root.classList.add("agent-overview-view");
  pollAgentInbox();
  root.querySelectorAll('tr[data-task-id]').forEach(tr=>{
    const row=doc.rows.find(r=>r.id===tr.dataset.taskId);if(!row||row.status==='closed')return;
    const actions=document.createElement('div');actions.className='row-dispatch';actions.innerHTML='<button type="button" class="button primary">Send to agent ↗</button><p role="status"></p>';
    tr.cells[tr.cells.length-1].append(actions);
    const button=actions.querySelector('button'),status=actions.querySelector('p');controls.set(row.id,{actions,button,status});
    status.textContent=row.commentInProgress?'In progress':row.commentAcknowledged?'Reviewed':row.comment?.trim()&&row.comment.trim()!=='**'?'Not taken yet':'';
    tr.querySelector('[aria-label="Комментарий '+row.id+'"]')?.addEventListener('input',()=>{status.textContent='Not sent';});
    api('/api/codex/preview',{ids:[row.id]}).then(({tasks})=>{const prior=tasks[0]?.previous;if(status.textContent==='Not taken yet'&&prior?.state==='queued')status.textContent='Queued · not taken yet';}).catch(()=>{});
    button.onclick=()=>sendRows([row.id]);
  });
}

function followCaret(element) {
  requestAnimationFrame(()=>{
    const selection=getSelection();if(!selection?.isCollapsed||!selection.rangeCount||!element.contains(selection.anchorNode))return;
    const rect=selection.getRangeAt(0).getBoundingClientRect();if(!rect.height)return;
    const bottom=innerHeight-110,top=90;
    if(rect.bottom>bottom)window.scrollBy({top:rect.bottom-bottom,behavior:'instant'});
    else if(rect.top<top)window.scrollBy({top:rect.top-top,behavior:'instant'});
  });
}
// Agents comments use the same native editing, shortcuts and Markdown writer.
window.HorizonRichText={
  mount(element,label,onchange,onblur){
    const commit=()=>{const copy=element.cloneNode(true);while(copy.firstChild&&(copy.firstChild.nodeName==='BR'||copy.firstChild.nodeType===3&&!copy.firstChild.textContent.trim()))copy.firstChild.remove();onchange(markdownWriter.turndown(cleanHtml(copy.innerHTML)));};
    writable(element,label,commit,{flush:onblur});
    element.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!event.ctrlKey&&!event.metaKey){event.preventDefault();document.execCommand(event.shiftKey?'insertLineBreak':'insertParagraph');commit();}});
  },
  bookmark(element){
    const selection=getSelection();if(!selection?.rangeCount||!element.contains(selection.anchorNode)||!element.contains(selection.focusNode))return null;
    const range=selection.getRangeAt(0),before=range.cloneRange();before.selectNodeContents(element);before.setEnd(range.startContainer,range.startOffset);
    return {start:before.toString().length,end:before.toString().length+range.toString().length};
  },
  restore(element,bookmark){
    if(!bookmark)return;const range=document.createRange(),walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    const point=offset=>{for(const node of nodes){if(offset<=node.length)return [node,offset];offset-=node.length;}const last=nodes.at(-1);return last?[last,last.length]:[element,0];};
    range.setStart(...point(bookmark.start));range.setEnd(...point(bookmark.end));
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  }
};
function renderProseEditor(doc,session,generation) {
  const root=$('.document-main');root.innerHTML='<div class="visual-error" role="status"></div><article class="visual-document markdown prose-editor"><div class="visual-block"></div></article>';
  documentActions(root,doc,'visual');const editor=root.querySelector('.visual-block');
  const meta=document.createElement('p');meta.className='document-meta';meta.textContent=documentMetadata(doc);editor.before(meta);
  session.viewValue=session.value;
  const originals=new Map(),dirtyGroups=new Set();let prefix='',previous=null;
  for(const piece of sourcePieces(session.value)){
    if(!piece.token||piece.token.type==='space'){if(previous)previous.raw+=piece.raw;else prefix+=piece.raw;continue;}
    const tokens=[piece.token];tokens.links=piece.links;const box=document.createElement('div');box.innerHTML=cleanHtml(marked.parser(tokens));
    const nodes=[...box.children];if(!nodes.length){if(previous)previous.raw+=piece.raw;else prefix+=piece.raw;continue;}
    const group={nodes,html:nodes.map(n=>n.outerHTML),raw:piece.raw};for(const node of nodes){originals.set(node,group);editor.append(node);}previous=group;
  }
  const markDirty=()=>{const selection=getSelection();if(!selection?.rangeCount)return;const r=selection.getRangeAt(0);let first=r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement,last=r.endContainer.nodeType===1?r.endContainer:r.endContainer.parentElement;while(first&&first.parentElement!==editor)first=first.parentElement;while(last&&last.parentElement!==editor)last=last.parentElement;if(first&&last)for(let node=first;node;node=node.nextElementSibling){const group=originals.get(node);if(group)dirtyGroups.add(group);if(node===last)break;}};
  editor.addEventListener('beforeinput',event=>{if(event.inputType?.startsWith('history'))for(const group of originals.values())dirtyGroups.add(group);else markDirty();});
  editor.addEventListener('input',markDirty);
  const commit=()=>{
    const children=[...editor.children].filter(n=>!n.hasAttribute('data-comment-ui'));let text=prefix;
    for(let i=0;i<children.length;i++){
      const node=children[i],group=originals.get(node);
      const clean=node=>{if(!node.querySelector('[data-comment-ui]'))return node.outerHTML;const clone=node.cloneNode(true);clone.querySelectorAll('[data-comment-ui]').forEach(n=>n.remove());return clone.outerHTML;};
      if(group&&group.nodes[0]===node&&group.nodes.every((n,j)=>children[i+j]===n&&(!dirtyGroups.has(group)||clean(n)===group.html[j]))){text+=group.raw;i+=group.nodes.length-1;}
      else {const raw=markdownWriter.turndown(cleanHtml(clean(node)));if(raw){if(text&&!text.endsWith('\n\n'))text+='\n';text+=raw+'\n\n';}}
    }
    session.set(text);
  };
  writable(editor,'Текст документа',commit,session);mountImageInsertion(editor,doc.path);
  const imageButton=document.createElement('button');imageButton.type='button';imageButton.className='button insert-image';imageButton.textContent='Изображение';imageButton.setAttribute('aria-label','Вставить изображение');imageButton.onmousedown=e=>e.preventDefault();imageButton.onclick=()=>imagePicker(editor,doc.path);root.querySelector('.document-chrome').append(imageButton);
  editor.addEventListener('keydown',event=>{if(event.target.closest('[data-comment-ui]'))return;if(event.key==='Enter'&&!event.isComposing&&!event.ctrlKey&&!event.metaKey){event.preventDefault();document.execCommand(event.shiftKey?'insertLineBreak':'insertParagraph');commit();}});
  session.notify=()=>{if(!editor.isConnected)return;meta.textContent=documentMetadata(session.doc);root.querySelector('[data-file=retry]').hidden=!session.error||session.error.status===409;status(root.querySelector('#visual-status'),session.error?'Не сохранено':session.inflight?'Сохраняется…':session.dirty()?'Есть изменения…':'Сохранено',Boolean(session.error));root.querySelector('.visual-error').textContent=session.error?.message||'';};
  mountDocumentComments(root,doc,editor);

  session.notify();if(session.dirty()&&!session.error)session.timer=setTimeout(()=>session.flush(),900);
  visualPoll=setInterval(async()=>{if(generation!==visualGeneration||!editor.isConnected||document.hidden||root.contains(document.activeElement)||session.dirty()||session.inflight||session.error)return;try{const fresh=await read(doc.path);if(fresh.revision!==session.revision){const y=scrollY;renderVisual(fresh);window.scrollTo({top:y});}}catch{}},5000);
}
