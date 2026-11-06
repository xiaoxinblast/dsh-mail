// Local synthetic model for the isolated native DSH UI verification only.
import { realpath, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { LlmAdapter } = await import(pathToFileURL(resolve(process.env.DSH_RUNTIME_MODULES, '@deepseek-ai/dsh-llm/lib/index.js')));
export const inject=['llm','mailWorkbench'];
export async function apply(ctx) {
 if(await realpath(process.env.DSH_HOME)!==await realpath(resolve('.cache/dsh-home')))throw Error('Isolated Host only');
 class Fixture extends LlmAdapter {
  async listModels(provider){return [{provider,id:'assistant-fixture',name:'邮箱验收模型',contextWindow:128000}];}
  async *stream(options){
   await appendFile(resolve('.cache/assistant-model-calls.jsonl'),JSON.stringify({messages:options.messages,tools:options.tools,model:options.model})+'\n');
   const human=options.messages.findLastIndex(m=>m.role==='user'&&m.source?.kind==='user');
   const turn=options.messages.slice(human), context=options.messages.findLast(m=>m.source?.kind==='dsh-mail-context');
   if(!context){if(options.messages[0]?.source?.kind !== 'dsh-session-title-llm')throw Error('Missing mail context');yield {type:'block-end',index:0,block:{type:'text',text:'Mailbox verification'}};yield {type:'finish',reason:{kind:'stop'}};return;}
   const source=JSON.parse(context.content[0].text.split('\n').slice(1).join('\n'));
   const results=turn.filter(m=>m.role==='tool'), instruction=turn[0].content.map(c=>c.text||'').join('');
   if(instruction.includes('[slow]'))await new Promise((resolve,reject)=>{const t=setTimeout(resolve,12000);options.signal.addEventListener('abort',()=>{clearTimeout(t);reject(options.signal.reason)},{once:true});});
   options.signal.throwIfAborted();
   let call;
   if(instruction.includes('回复草稿')) {
    if(results.length===0)call={name:'mail_drafts',arguments:JSON.stringify({action:'drafts.reply',args:{id:source.message.id,mode:'reply',display:false}})};
    else if(results.length===1){const d=JSON.parse(results[0].content.find(c=>c.type==='text').text);call={name:'mail_drafts',arguments:JSON.stringify({action:'drafts.save',args:{draft:{...d,text:'已核对完整往来，确认周五交付。\n\n'+d.quotedText,html:'<p>已核对完整往来，确认周五交付。</p>'+d.html}}})};}
   } else if(instruction.includes('发送预览')&&results.length===0)call={name:'mail_drafts',arguments:JSON.stringify({action:'send.preview',args:{id:source.draft.id}})};
   else if(instruction.includes('待办')&&results.length===0)call={name:'mail_resources',arguments:JSON.stringify({action:'resources.save',args:{kind:'tasks',value:{title:'[合成] 核对邮件交付',sourceMessageId:source.message.id}}})};
   if(call){yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixture-'+Date.now(),...call}};yield {type:'finish',reason:{kind:'tool-calls'}};}
   else {yield {type:'block-end',index:0,block:{type:'text',text:'已读取当前邮件「'+(source.message?.subject||source.draft?.subject)+'」及完整引用。'+(results.length?'工具执行完成，请在邮件工作台查看结果。':'本次原文：'+source.message?.text)}};yield {type:'finish',reason:{kind:'stop'}};}
  }
 }
 ctx.llm.registerAdapter(['mail-assistant-fixture'],new Fixture());
 const service=ctx.mailWorkbench.service;
 const message=service.store.message('actions-original');
 if(message)service.store.upsertMessage({...message,text:'本轮说明',html:'<p>本轮说明</p><blockquote>第一轮引用<blockquote>最早报价 12345</blockquote></blockquote>'});
}
