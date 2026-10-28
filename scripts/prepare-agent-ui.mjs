// Prepare a test-only Cordis plugin. Add the printed overlay only to .cache/dsh-home.
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
if (!process.argv[2]) throw new Error("Pass the DSH rc.3 node_modules directory");
const modules = await realpath(process.argv[2]), cache = resolve(".cache");
await mkdir(cache, { recursive: true });
const tools = pathToFileURL(join(modules, "@deepseek-ai/dsh-tools/lib/index.js")).href, llm = pathToFileURL(join(modules, "@deepseek-ai/dsh-llm/lib/index.js")).href;
await readFile(new URL(tools)); await readFile(new URL(llm));
const agent = (await readFile("dsh/agent.mjs", "utf8")).replace('"@deepseek-ai/dsh-tools"', JSON.stringify(tools));
await writeFile(join(cache, "agent-under-test.mjs"), agent);
await writeFile(join(cache, "agent-ui-harness.mjs"), `
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { apply as register } from './agent-under-test.mjs';
import { createUserMessage } from ${JSON.stringify(llm)};
export const inject=['mailWorkbench','sessions'];
export async function apply(ctx) {
  if(await realpath(process.env.DSH_HOME)!==await realpath(new URL('./dsh-home',import.meta.url)))throw new Error('Harness requires repository-local isolated DSH_HOME');
  const definitions=new Map();
  register({effect:f=>f(),tools:{presentAs:()=>()=>{},register:def=>definitions.set(def.name,def)},systemPrompt:{section(){}},mailWorkbench:ctx.mailWorkbench});
  let last,running=false;
  const timer=setInterval(async()=>{
    if(running)return;running=true;
    try {
      const input=JSON.parse(await readFile(new URL('./agent-ui-request.json',import.meta.url),'utf8'));
      if(last===input.id)return;last=input.id;
      try {
        let result;
        if(input.tool==='harness'&&input.action==='seed-session') {
          const session=ctx.sessions.get(input.sessionId);if(!session)throw new Error('Session not mounted');
          const turn=(session.log.filter(e=>e.type==='turn/start').at(-1)?.data.turn||0)+1; session.append('turn/start',{turn});
          session.append('user/message',createUserMessage({content:[{type:'text',text:'合成会话消息：工作台界面验收'}],source:{kind:'user'}}),{surfaceOp:'append'}); session.append('turn/end',{turn,reason:{kind:'completed'}});result={ok:true};
        } else result=await definitions.get(input.tool).execute({action:input.action,args:input.args||{}},{agent:{session:{header:{id:input.sessionId}}}});
        await writeFile(new URL('./agent-ui-response.json',import.meta.url),JSON.stringify({id:input.id,result}));
      }catch(e){await writeFile(new URL('./agent-ui-response.json',import.meta.url),JSON.stringify({id:input.id,error:{message:e.message,code:e.code}}));}
    }catch(e){if(e.code!=='ENOENT')console.error(e);}finally{running=false;}
  },100);
  ctx.effect(()=>()=>clearInterval(timer));
}
`);
console.log(`- insert:\n    - id: agent-ui-harness\n      name: ${JSON.stringify(pathToFileURL(join(cache, "agent-ui-harness.mjs")).href)}`);
