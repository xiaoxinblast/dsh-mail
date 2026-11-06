// Run with the isolated Host stopped; this resets only repository-local synthetic state.
import { writeFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
const modules = await realpath(process.argv[2]);
const service = new MailService({ directory: resolve(".cache/dsh-home/dsh-mail/web"), transport: { close: async () => {} } });
try {
  service.store.remove("assistant-sessions", "main");
  for (const kind of ["previews", "notifications"]) for (const item of service.store.list(kind)) service.store.remove(kind, item.id);
  service.store.put("accounts", { ...normalizeAccount({ id: "actions-ui", name: "合成验收邮箱", email: "actions-me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", imapPort: 9, smtpPort: 9 }), authFailed: true, nextSyncAt: Date.now() + 86400000 });
  service.store.put("folders", { id: "actions-inbox", accountId: "actions-ui", path: "actions-inbox", role: "\\Inbox" });
  for (const [i, subject] of ["[验收] 联系人与内置 AI", "[验收] 另一封上下文邮件"].entries()) service.store.upsertMessage({ id: i ? "assistant-other" : "actions-original", accountId: "actions-ui", folderId: "actions-inbox", uid: i + 50, uidValidity: "assistant", messageId: `<assistant-${i}@example.invalid>`, date: new Date().toISOString(), subject, from: [{ name: "山田客户", address: "actions-client@example.invalid" }], to: [{ address: "actions-me@example.invalid" }], cc: [], bodyLoaded: true, text: i ? "第二封邮件的专属信息：周三评审。" : "本轮说明", html: i ? "" : "<p>本轮说明</p><blockquote>第一轮引用<blockquote>最早报价 12345</blockquote></blockquote>", attachments: [], flags: ["\\Seen"], seen: true });
} finally { await service.close(); }
await writeFile(".cache/assistant-model-calls.jsonl", "");
await writeFile(".cache/mail-assistant.patch.yml", `- id: agent-default-model\n  config:\n    provider: mail-assistant-fixture\n    model: assistant-fixture\n- insert:\n    - id: mail-assistant-model\n      name: ${JSON.stringify(pathToFileURL(resolve("scripts/fixtures/assistant-model.mjs")).href)}\n`);
await writeFile(".cache/current-launch.mjs", `process.env.DSH_RUNTIME_MODULES=${JSON.stringify(modules)};\nconst {runCli}=await import(${JSON.stringify(pathToFileURL(resolve(modules, "@deepseek-ai/dsh/lib/bin.js")).href)});\nawait runCli();\n`);
console.log("Prepared isolated native Mail Agent verification. Use DSH_HOME=.cache/dsh-home and --patch .cache/mail-assistant.patch.yml; no real provider or SMTP.");
