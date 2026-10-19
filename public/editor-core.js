globalThis.HorizonEditor={
  tabs(initial=[]) {
    const state={paths:[...new Set(Array.isArray(initial)?initial.filter(p=>typeof p==='string'&&/\.(md|html)$/.test(p)):[])],
      open(path){if(!this.paths.includes(path))this.paths.push(path);return path;},
      close(path){const i=this.paths.indexOf(path);if(i<0)return this.paths[0]||null;this.paths.splice(i,1);return this.paths[i]||this.paths[i-1]||null;},
      remap(from,to){this.paths=[...new Set(this.paths.map(p=>HorizonEditor.remapPath(p,from,to)))];}
    };return state;
  },
  documentLink(current,href){
    if(!href||/^(?:[a-z]+:|\/\/)/i.test(href))return null;
    try{const url=new URL(href,'http://horizon/'+current),path=decodeURIComponent(url.pathname.slice(1));
      const project=current.match(/^projects\/[^/]+\//)?.[0];if(project&&!path.startsWith(project))return null;
      return {path,heading:decodeURIComponent(url.hash.slice(1))};
    }catch{return null;}
  },
  locateQuote(text,c) {
    if(!c.quote)return null;const hits=[];let start=0;
    while((start=text.indexOf(c.quote,start))!==-1){hits.push(start);start+=Math.max(1,c.quote.length);}
    if(hits.length===1)return {start:hits[0],end:hits[0]+c.quote.length};
    const matches=hits.filter(at=>(!c.prefix||text.slice(0,at).endsWith(c.prefix))&&(!c.suffix||text.slice(at+c.quote.length).startsWith(c.suffix)));
    return matches.length===1?{start:matches[0],end:matches[0]+c.quote.length}:null;
  },
  remapPath(value,from,to){return value===from||value?.startsWith(from+'/')?to+value.slice(from.length):value;}
};
