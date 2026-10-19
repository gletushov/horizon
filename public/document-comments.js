const documentViewMemory=new Map();
function documentText(root) {
  const nodes=[];let text='';const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){const node=walker.currentNode;if(node.parentElement.closest('[data-comment-ui]'))continue;nodes.push({node,start:text.length});text+=node.textContent;}
  return {nodes,text};
}
function textOffset(root,node,offset) {const r=document.createRange();r.selectNodeContents(root);r.setEnd(node,offset);const box=document.createElement('div');box.append(r.cloneContents());box.querySelectorAll('[data-comment-ui]').forEach(n=>n.remove());return box.textContent.length;}
function textRange(root,start,end) {
  const {nodes}=documentText(root),first=nodes.find(n=>n.start+n.node.length>start),last=nodes.find(n=>n.start+n.node.length>=end);if(!first||!last)return null;
  const range=document.createRange();range.setStart(first.node,start-first.start);range.setEnd(last.node,end-last.start);return range;
}
function rememberDocumentView() {
  if(!activeDoc)return;const editor=$('.prose-editor [contenteditable]'),selection=getSelection();
  const state={y:scrollY,mode:$('.document-main')?.dataset.editorMode||'visual'};
  const source=$('#document-source');if(source){state.sourceCaret=[source.selectionStart,source.selectionEnd];state.sourceScroll=source.scrollTop;state.focused=document.activeElement===source;}
  if(editor&&selection?.rangeCount&&editor.contains(selection.anchorNode)&&editor.contains(selection.focusNode)){const range=selection.getRangeAt(0);state.caret=[textOffset(editor,range.startContainer,range.startOffset),textOffset(editor,range.endContainer,range.endOffset)];state.focused=document.activeElement===editor;}
  documentViewMemory.set(activeDoc.path,state);try{localStorage.setItem('horizon:view:'+activeDoc.path,JSON.stringify(state));}catch{}
}
function savedDocumentView(path) {if(documentViewMemory.has(path))return documentViewMemory.get(path);try{return JSON.parse(localStorage.getItem('horizon:view:'+path));}catch{return null;}}
function restoreDocumentView() {
  const path=activeDoc?.path,state=savedDocumentView(path);if(!state)return;
  requestAnimationFrame(()=>{if(activeDoc?.path!==path)return;const source=$('#document-source');if(source&&state.sourceCaret){source.setSelectionRange(...state.sourceCaret);source.scrollTop=state.sourceScroll||0;if(state.focused)source.focus({preventScroll:true});}const editor=$('.prose-editor [contenteditable]');if(state.caret&&editor){const range=textRange(editor,...state.caret);if(range){if(state.focused)editor.focus({preventScroll:true});const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}}window.scrollTo({top:state.y||0});});
}
async function mountDocumentComments(root,doc,editor) {
  root.commentsCleanup?.();const panel=document.createElement('aside');panel.className='document-comments';panel.setAttribute('aria-label','Комментарии к документу');const grid=document.createElement('div');grid.className='document-grid';const article=editor.closest('article');article.replaceWith(grid);grid.append(article,panel);
  let discussion=null,closed=false,pending=null,editing=null,frame=null;const ranges=new Map();
  const draftPath=()=> 'annotation:'+doc.path;
  let recovered=draft(draftPath());
  const alive=()=>!closed&&editor.isConnected;
  const cleanCards=()=>{root.querySelectorAll('[data-comment-ui]').forEach(n=>n.remove());panel.replaceChildren();};
  const highlight=()=>{if(!CSS.highlights)return;const list=new Highlight(...ranges.values());CSS.highlights.set('document-comments',list);};
  const align=()=>{
    if(!alive())return;const inline=matchMedia('(max-width:1279px)').matches;let last=0;
    for(const card of [...root.querySelectorAll('[data-comment-ui]')].sort((a,b)=>{const left=ranges.get(a.dataset.commentId),right=ranges.get(b.dataset.commentId);return left&&right?left.compareBoundaryPoints(Range.START_TO_START,right):left?-1:right?1:0;})){
      const range=ranges.get(card.dataset.commentId);
      if(inline&&range){let node=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement;while(node.parentElement!==editor&&node!==editor)node=node.parentElement;if(node!==editor){while(node.nextElementSibling?.hasAttribute('data-comment-ui')&&node.nextElementSibling!==card)node=node.nextElementSibling;if(node.nextElementSibling!==card)node.after(card);card.style.top='';continue;}}
      if(card.parentNode!==panel)panel.append(card);if(!inline){const y=range?range.getBoundingClientRect().top-grid.getBoundingClientRect().top+3:0;last=Math.max(last,y);card.style.top=last+'px';last+=card.offsetHeight+16;}else card.style.top='';
    }
    panel.style.minHeight=inline?'0':Math.max(last,20)+'px';
  };
  const update=()=>{
    if(!alive())return;ranges.clear();const {text}=documentText(editor);
    for(const c of [...(discussion?.comments||[]),...(pending?[pending]:[])]){const found=HorizonEditor.locateQuote(text,c);if(found){const range=textRange(editor,found.start,found.end);if(range)ranges.set(c.id,range);}}
    highlight();root.querySelectorAll('[data-comment-ui]').forEach(card=>{const state=card.querySelector('.comment-state');if(state)state.textContent=ranges.has(card.dataset.commentId)?'':'Фрагмент изменён';});align();
  };
  const mutate=async(data)=>{const fresh=await settled(doc.path);discussion=await api('/api/annotations',{path:doc.path,revision:discussion.revision,sourceRevision:fresh.revision,...data});return discussion;};
  const render=()=>{
    if(!alive())return;cleanCards();const comments=[...(discussion?.comments||[])];if(pending)comments.push(pending);
    for(const c of comments){
      const card=document.createElement('div');card.className='comment-note';card.dataset.commentUi='true';card.dataset.commentId=c.id;card.contentEditable='false';
      const quote=document.createElement('div');quote.className='comment-quote';quote.textContent=c===pending||editing===c.id?'“'+c.quote+'”':c.quote;card.append(quote);const state=document.createElement('div');state.className='comment-state';card.append(state);
      const actions=document.createElement('div');actions.className='comment-actions';
      if(c===pending||editing===c.id){
        card.classList.add('comment-compose');
        const input=document.createElement('textarea');input.rows=3;input.setAttribute('aria-label','Комментарий к цитате');input.placeholder='Твой комментарий';input.value=c.text||'';card.append(input);const error=document.createElement('div');error.className='comment-error';error.setAttribute('role','status');card.append(error);
        input.oninput=()=>{c.text=input.value;keepDraft(draftPath(),{...c,editing:editing===c.id});align();};
        const cancel=document.createElement('button');cancel.textContent='Отмена';cancel.onclick=()=>{pending=null;editing=null;recovered=null;clearDraft(draftPath());render();};
        const save=document.createElement('button');save.className='comment-save';save.textContent='Сохранить';save.onclick=async()=>{if(!input.value.trim())return input.focus();save.disabled=true;try{await mutate(c===pending?{action:'add',quote:c.quote,prefix:c.prefix,suffix:c.suffix,start:c.start,text:input.value}:{action:'edit',id:c.id,text:input.value});pending=null;editing=null;recovered=null;clearDraft(draftPath());render();}catch(e){error.textContent=e.message;save.disabled=false;keepDraft(draftPath(),{...c,text:input.value,editing:editing===c.id});if(e.status===409){try{discussion=await api('/api/annotations?path='+encodeURIComponent(doc.path));}catch{}}}};
        input.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();cancel.click();}if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();save.click();}};actions.append(cancel,save);requestAnimationFrame(()=>{if(alive())input.focus({preventScroll:true});});
      } else {
        const text=document.createElement('p');text.textContent=c.text;card.append(text);
        const edit=document.createElement('button');edit.textContent='Изменить';edit.onclick=()=>{editing=c.id;pending=null;render();};
        const remove=document.createElement('button');remove.textContent='Удалить';remove.onclick=async()=>{remove.disabled=true;try{await mutate({action:'delete',id:c.id});render();treeMessage('Комментарий удалён',async()=>{await mutate({action:'restore',id:c.id});render();});}catch(e){remove.disabled=false;toast(e.message);}};actions.append(edit,remove);
      }
      card.append(actions);panel.append(card);
      card.onpointerenter=()=>{card.classList.add('on');const range=ranges.get(c.id);if(CSS.highlights&&range)CSS.highlights.set('document-active-comment',new Highlight(range));};card.onpointerleave=()=>{card.classList.remove('on');CSS.highlights?.delete('document-active-comment');};
    }
    update();
  };
  const add=async()=>{
    const selection=getSelection();if(!selection?.rangeCount||selection.isCollapsed||!editor.contains(selection.anchorNode)||!editor.contains(selection.focusNode))return;
    const range=selection.getRangeAt(0),{text}=documentText(editor);let start=textOffset(editor,range.startContainer,range.startOffset),end=textOffset(editor,range.endContainer,range.endOffset),quote=text.slice(start,end);start+=quote.length-quote.trimStart().length;quote=quote.trim();end=start+quote.length;if(!quote)return;
    try{if(!await documentSessions.get(doc.path).flush())throw Error('Сначала сохраните документ.');pending={id:'draft',quote,prefix:text.slice(Math.max(0,start-64),start),suffix:text.slice(end,end+64),start,text:''};editing=null;keepDraft(draftPath(),pending);if(textSelectionTools)textSelectionTools.hidden=true;render();}catch(e){toast(e.message);}
  };
  root.addDocumentComment=add;
  let hovered=null;const quoteHover=e=>{let id=null;for(const [key,range]of ranges){if([...range.getClientRects()].some(r=>e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom)){id=key;break;}}if(id===hovered)return;hovered=id;for(const card of root.querySelectorAll('[data-comment-ui]'))card.classList.toggle('on',card.dataset.commentId===id);if(CSS.highlights){if(id)CSS.highlights.set('document-active-comment',new Highlight(ranges.get(id)));else CSS.highlights.delete('document-active-comment');}};const quoteLeave=()=>{hovered=null;root.querySelectorAll('[data-comment-ui]').forEach(card=>card.classList.remove('on'));CSS.highlights?.delete('document-active-comment');};editor.addEventListener('pointermove',quoteHover);editor.addEventListener('pointerleave',quoteLeave);
  const onInput=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};editor.addEventListener('input',onInput);window.addEventListener('resize',update);
  root.commentsCleanup=()=>{closed=true;cancelAnimationFrame(frame);editor.removeEventListener('pointermove',quoteHover);editor.removeEventListener('pointerleave',quoteLeave);editor.removeEventListener('input',onInput);window.removeEventListener('resize',update);CSS.highlights?.delete('document-comments');CSS.highlights?.delete('document-active-comment');};
  try {discussion=await api('/api/annotations?path='+encodeURIComponent(doc.path));if(!alive())return;if(recovered){if(recovered.editing&&discussion.comments.some(c=>c.id===recovered.id)){editing=recovered.id;Object.assign(discussion.comments.find(c=>c.id===editing),{text:recovered.text});}else pending={...recovered,id:'draft'};}render();}
  catch(e){if(!alive())return;panel.textContent='Комментарии недоступны: '+e.message;}
}
