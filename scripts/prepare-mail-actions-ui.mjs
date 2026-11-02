// Synthetic fixtures and a local LLM adapter, restricted to the repository's isolated Host.
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
const modules = await realpath(process.argv[2]), cache = resolve(".cache");
await mkdir(cache, { recursive: true });
const llm = pathToFileURL(join(modules, "@deepseek-ai/dsh-llm/lib/index.js")).href;
await readFile(new URL(llm));
const service = new MailService({ directory: resolve(".cache/dsh-home/dsh-mail/web"), transport: { close: async () => {} } });
try {
  service.store.put("accounts", { ...normalizeAccount({ id: "actions-ui", name: "快捷操作验收", email: "actions-me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", imapPort: 9, smtpPort: 9 }), authFailed: true, nextSyncAt: Date.now() + 86400000, folders: { sent: "actions-sent" } });
  for (const [id, role] of [["actions-inbox", "\\Inbox"], ["actions-sent", "\\Sent"]]) service.store.put("folders", { id, role, accountId: "actions-ui", path: id });
  for (const [i, value] of [{ id: "actions-original", subject: "[验收] 联系人与内置 AI", from: [{ name: "山田客户", address: "actions-client@example.invalid" }] }, { id: "actions-reply", subject: "Re: [验收] 联系人与内置 AI", folderId: "actions-sent", from: [{ name: "我", address: "actions-me@example.invalid" }], to: [{ name: "历史收件人", address: "actions-history@example.invalid" }], references: ["<actions-original@example.invalid>"] }].entries()) service.store.upsertMessage({ accountId: "actions-ui", folderId: "actions-inbox", uidValidity: "1", uid: i + 1, messageId: `<${value.id}@example.invalid>`, date: new Date(Date.UTC(2026, 10, 2, 8, i)).toISOString(), subject: "", text: "お世話になっております。金曜日までにご確認をお願いいたします。", bodyLoaded: true, to: [{ address: "actions-me@example.invalid" }], cc: [{ name: "抄送同事", address: "actions-cc@example.invalid" }], attachments: [], flags: [], ...value });
} finally { await service.close(); }
await writeFile(join(cache, "mail-actions-model.mjs"), `
import { realpath, appendFile } from 'node:fs/promises';
import { LlmAdapter } from ${JSON.stringify(llm)};
export const inject=['llm','mailWorkbench'];
export async function apply(ctx) {
  if(await realpath(process.env.DSH_HOME)!==await realpath(new URL('./dsh-home',import.meta.url))) throw new Error('Isolated repository Host only');
  class Fixture extends LlmAdapter {
    async listModels(){return [{id:'inline-fixture',name:'本机合成模型',contextWindow:128000}];}
    async *stream(options){
      const input=JSON.parse(options.messages[0].content[0].text);
      await appendFile(new URL('./inline-model-calls.jsonl',import.meta.url),JSON.stringify({input,system:options.system,model:options.model})+'\\n');
      if(input.instruction?.includes('[slow]')) await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,2000);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason)},{once:true});});
      options.signal.throwIfAborted();
      if(input.instruction?.includes('[fail]')) throw new Error('合成模型失败，请重试');
      const text=JSON.stringify({subject:'[AI] '+(input.source.subject||'项目邮件'),text:'这是本机合成 AI 结果。\\n语言：'+input.language+'\\n要求：'+input.instruction+'\\n原文：'+input.source.text});
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:input.instruction?.includes('[truncate]')?'max-tokens':'stop'}};
    }
  }
  ctx.effect(()=>ctx.llm.registerAdapter(['mail-actions-fixture'],new Fixture()));
}
`);
await writeFile(join(cache, "mail-actions.patch.yml"), `- id: agent-default-model\n  config:\n    provider: mail-actions-fixture\n    model: inline-fixture\n- insert:\n    - id: mail-actions-model\n      name: ${JSON.stringify(pathToFileURL(join(cache, "mail-actions-model.mjs")).href)}\n`);
console.log("Prepared synthetic contacts, mail and local LLM adapter; use .cache/mail-actions.patch.yml on the isolated Host only.");
