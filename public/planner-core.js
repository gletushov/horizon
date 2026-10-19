/* Shared browser/server Markdown contract. No I/O or dependencies. */
(function (host) {
  const colors = ['green','yellow','blue','pink','purple','neutral'];
  const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '9999-12-31' && !Number.isNaN(Date.parse(value)) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value;
  const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const shiftDate = (date, days) => {const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
  const isPath = value => typeof value === 'string' && (/^planner\/(day|week|month|quarter|year|future|life)\.md$/.test(value) || /^planner\/days\/(\d{4}-\d{2}-\d{2})\.md$/.test(value) && dateValid(value.slice(13,-3)));
  const parseMeta = line => {
    const raw = line.match(/<!--\s*horizon:(.*?)\s*-->/)?.[1];
    if (raw === undefined) return {};
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {invalid:true};
      const allowed = new Set(['id','color','highlight','due','comments']);
      if (Object.keys(value).some(key => !allowed.has(key))) return {invalid:true};
      if (value.id !== undefined && value.id !== null && (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id))) return {invalid:true};
      if (value.color !== undefined && value.color !== null && !colors.includes(value.color)) return {invalid:true};
      if (value.highlight !== undefined && typeof value.highlight !== 'boolean') return {invalid:true};
      if (value.due !== undefined && value.due !== null && !dateValid(value.due)) return {invalid:true};
      if (value.comments !== undefined && (!Array.isArray(value.comments) || value.comments.some(c => !c || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(c.id) || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 10000 || typeof c.author !== 'string' || typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt))) || new Set(value.comments.map(c=>c.id)).size !== value.comments.length)) return {invalid:true};
      return {comments:value.comments || [], id:value.id || null, color:value.color || 'green', highlight:value.highlight ?? false, due:value.due || null};
    } catch { return {invalid:true}; }
  };
  function tasks(content) {
    const lines=content.split('\n'), result=[];
    for(let index=0;index<lines.length;index++) {
      const match=lines[index].match(/^[-*] \[([ xX])\] (.*)\r?$/);if(!match)continue;
      let end=index+1;while(end<lines.length&&(!lines[end].trim()||/^\s+\S/.test(lines[end])))end++;
      const task={index,end,text:match[2].replace(/\r$/,''),done:match[1]!==' ',id:null,color:'green',highlight:false,due:null,note:'',comments:[],children:[],noteIndices:[],metaIndex:null};
      let inNote=false, explicit=false, note=[], legacy=[], fence=false;
      for(let i=index+1;i<end;i++) {
        const line=lines[i].replace(/\r$/,'');
        if(line.trim()==='<!-- horizon-note -->'){if(inNote)task.invalid=true;inNote=true;explicit=true;task.noteIndices.push(i);continue;}
        if(line.trim()==='<!-- /horizon-note -->'){if(!inNote)task.invalid=true;inNote=false;task.noteIndices.push(i);continue;}
        if(inNote){note.push(line.replace(/^ {2}/,''));task.noteIndices.push(i);continue;}
        if(/^\s+<!--\s*horizon:/.test(line)){const metadata=parseMeta(line);if(metadata.invalid)task.invalid=true;else {task.id=metadata.id;task.color=metadata.color;task.highlight=metadata.highlight;task.due=metadata.due;task.comments=metadata.comments;}task.metaIndex=i;continue;}
        if(/^\s*(```|~~~)/.test(line))fence=!fence;
        const child=!fence&&line.match(/^(\s+)[-*] \[([ xX])\] (.*)$/);
        if(child){const metadata=parseMeta(child[3]);if(metadata.invalid)task.invalid=true;task.children.push({index:i,done:child[2]!==' ',text:child[3].replace(/\s*<!-- horizon:.*? -->$/,''),level:Math.max(1,Math.ceil(child[1].length/2)),id:metadata.id||null,color:metadata.color||null,indent:child[1]});}
        else {legacy.push(line.replace(/^ {2}/,''));task.noteIndices.push(i);}
      }
      if(inNote)task.invalid=true;
      task.note=(explicit?note.join('\n'):legacy.join('\n').trim());
      task.children.forEach(c=>c.color=c.color||task.color);
      result.push(task);index=end-1;
    }
    return result;
  }
  function dayNote(content) {
    const lines=content.split('\n'),start=lines.indexOf('<!-- horizon-day-note -->'),end=lines.indexOf('<!-- /horizon-day-note -->');
    return start>=0&&end>start?lines.slice(start+1,end).map(l=>l.replace(/^ {2}/,'')).join('\n'):'';
  }
  function setDayNote(content,note) {
    const lines=content.split('\n'),start=lines.indexOf('<!-- horizon-day-note -->'),end=lines.indexOf('<!-- /horizon-day-note -->');
    const block=['<!-- horizon-day-note -->',...note.split('\n').map(l=>'  '+l),'<!-- /horizon-day-note -->'];
    if(start>=0&&end>start)lines.splice(start,end-start+1,...block);else lines.splice(1,0,'',...block,'');
    return lines.join('\n');
  }
  host.HorizonPlanner={colors,dateValid,today,shiftDate,isPath,tasks,dayNote,setDayNote};
})(globalThis);
