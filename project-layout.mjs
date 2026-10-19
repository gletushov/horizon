import fs from 'node:fs';
import path from 'node:path';
export function initializeProject(root){
  const files={
    'notes/inbox.md':'# Inbox\n\nЛичные мысли и быстрые записи. Агенты разбирают их только по поручению.\n',
    'notes/tasks.md':'# Мои задачи\n\n',
    'agents/README.md':'# Работа агентов\n\nАктивные задачи — в tasks/Tnn-topic.md. Одна задача — один файл; продолжайте его в следующих сессиях. Принятые завершённые материалы — в archive/YYYY-MM/.\n',
    'docs/README.md':'# Документация\n\nЗдесь хранятся принятые решения и действующие инструкции проекта.\n',
    '.agents/horizon-workflow.md':'# Работа через Horizon\n\nЛичные заметки владельца находятся в notes; меняйте их только по поручению. Рабочие материалы агентов — agents/tasks/Tnn-topic.md, где Tnn — выданный Horizon ID. Код остаётся в своей обычной структуре.\n\nОдна задача — одна строка в сводке; после значимого результата обновляйте её через review-agent.mjs с актуальной revision. Сохраняйте все пользовательские комментарии. Пустая ячейка не означает согласия. Подробности храните внутри своего проекта, в сводке оставляйте ссылку.\n\nГотовый результат: Needs review. После явного принятия либо выполнения согласованного критерия: Done. Архивируйте рабочий файл в agents/archive/YYYY-MM только после принятия, переноса полезных решений в docs и закрытия вопросов. Сохраняйте текст, комментарии и ссылки. Возраст файла не повод для архивации.\n',
    'README.md':'# Проект\n\n- [Личные записи](notes/inbox.md)\n- [Мои задачи](notes/tasks.md)\n- [Работа агентов](agents/README.md)\n- [Документация](docs/README.md)\n'
  };
  const created=[];
  for(const [relative,content]of Object.entries(files)){
    let current=root;for(const segment of relative.split('/').slice(0,-1)){current=path.join(current,segment);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('Cannot initialize through a symbolic link: '+current);fs.mkdirSync(current,{recursive:true});}
    const file=path.join(root,relative);if(fs.existsSync(file))continue;fs.writeFileSync(file,content,{flag:'wx'});created.push(relative);
  }
  const instructions=path.join(root,'AGENTS.md');if(fs.existsSync(instructions)&&fs.lstatSync(instructions).isSymbolicLink())throw new Error('Cannot edit linked AGENTS.md');
  const text=fs.existsSync(instructions)?fs.readFileSync(instructions,'utf8'):'';
  if(!text.includes('.agents/horizon-workflow.md'))fs.appendFileSync(instructions,'\n## Работа через Horizon\n\nДля задач, зарегистрированных в Horizon, прочитайте [.agents/horizon-workflow.md](.agents/horizon-workflow.md).\n');
  return created;
}
