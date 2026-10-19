import {_electron as electron} from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {WorkspaceStore} from '../workspace-store.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'horizon-public-')),root=path.join(temp,'workspace');
fs.mkdirSync(path.join(root,'docs'),{recursive:true});
fs.writeFileSync(path.join(root,'docs/start.md'),'# Рабочая папка\n\n[План релиза](<'+path.join(root,'docs/plan.md')+'>)\n');
fs.writeFileSync(path.join(root,'docs/plan.md'),'# План релиза\n\nСобрать приложение, проверить сохранение и написать инструкцию.\n\n## До публикации\n\n- Проверить запуск из Программ\n- Оставить только демонстрационные данные\n- Приложить скриншоты\n');
const env={...process.env,HORIZON_USER_DATA:path.join(temp,'profile'),HORIZON_ROOT:root,HORIZON_CODEX_BIN:path.join(temp,'missing-codex')};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=process.argv[2]?path.resolve(process.argv[2]):undefined;
const app=await electron.launch({executablePath,args:executablePath?[]:['.'],env,timeout:90000});
const out=path.resolve(process.env.HORIZON_CHECK_OUTPUT||'output/public-ui');fs.mkdirSync(out,{recursive:true});
try{
 const page=await app.firstWindow();page.setDefaultTimeout(5000);const failures=[];
 const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTimezoneOverride',{timezoneId:'UTC'});
 await page.waitForLoadState('domcontentloaded');const origin=new URL(page.url()).origin;
 await page.goto(origin+'/#docs?docs%2Fstart.md');await page.getByRole('link',{name:'План релиза',exact:true}).click();
 try{await page.getByRole('heading',{name:'План релиза',exact:true}).waitFor();}catch{failures.push('absolute links must work for any workspace location');}
 const opened=await app.evaluate(async({Menu,shell})=>{
  const urls=[];shell.openExternal=async url=>{urls.push(url);};
  const help=Menu.getApplicationMenu().items.find(item=>item.label==='Справка');
  if(!help)return null;
  for(const label of ['Подключение агентов','Сообщить об ошибке']){const item=help.submenu.items.find(item=>item.label===label);if(!item)return null;await item.click();}
  return urls;
 });
 if(!opened?.some(url=>url.includes('/issues/new'))||!opened?.some(url=>url.includes('/docs/agents.md')))failures.push('native Help must open agent instructions and a blank bug form');
 if(opened?.some(url=>url.includes(root)||url.includes('План релиза')))failures.push('bug links must not contain workspace paths or document text');
 assert.deepEqual(failures,[]);
 assert.equal(await page.title(),'Horizon');
 await page.screenshot({path:path.join(out,'documents.png')});
 await page.locator('[data-nav="inbox"]').click();await page.locator('#note-capture').fill('Идея для следующего шага: собрать отзывы о первой версии.');
 await page.getByRole('button',{name:'Добавить',exact:true}).click();await page.locator('.continuous-note-entry').waitFor();
 const notes=await (await fetch(origin+'/api/notes')).json();
 const localTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'}).format(new Date(notes.entries[0].createdAt));
 assert.ok((await page.locator('.continuous-note-entry time').innerText()).includes(localTime),'note timestamps must follow the Mac timezone');
 await page.screenshot({path:path.join(out,'notes.png')});
 await page.locator('[data-nav="agents"]').click();await page.locator('.review-workspace').waitFor();
 const review=await (await fetch(origin+'/api/review')).json();
 await fetch(origin+'/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'create',title:'Подготовить первый релиз',projectId:null,comment:'Проверь сборку и приложи инструкцию со скриншотами.',revision:review.revision})});
 const store=new WorkspaceStore(root),document=store.read('reviews/agent-overview.md');
 store.agentReview(document.path,document.revision,[{id:document.rows[0].id,updates:'**Needs review.** Приложение собрано. Инструкция и скриншоты готовы. Следующий шаг — проверить запуск и принять результат.'}]);
 await page.reload();await page.getByRole('button',{name:'Скопировать задачу',exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'agents.png')});
 console.log(JSON.stringify({passed:true,checks:['portable absolute links','neutral title','Help links','bug link privacy','notes','agents'],screenshots:out}));
}finally{await app.close();fs.rmSync(temp,{recursive:true,force:true});}
