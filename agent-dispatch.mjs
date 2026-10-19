const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
// Both entry points use the current recipient; historical bindings never choose a writer.
export function prepareDispatch(store,bridge,ids){
 if(!Array.isArray(ids)||!ids.length||ids.length>30||new Set(ids).size!==ids.length)fail('Select 1–30 tasks');
 const doc=store.read('reviews/agent-overview.md');
 return ids.map(id=>{const row=doc.rows.find(r=>r.id===id);if(!row)fail('Unknown task '+id);
  try{const brief=store.review.brief({id,revision:doc.revision});if(brief.delivery!=='codex')return {id,error:'Текущий исполнитель не Codex. Скопируйте поручение в его сессию.'};return {...brief,previous:bridge.getRecord(brief.requestId)};}
  catch(error){return {id,title:row.taskTitle,error:error.message};}
 });
}
