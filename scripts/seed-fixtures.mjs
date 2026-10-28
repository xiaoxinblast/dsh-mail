// Test data only: this script never touches the user's DSH_HOME or network accounts.
import { resolve } from "node:path";
import { MailService } from "../src/service.mjs";
import { composeDraft } from "../src/mail.mjs";
const directory = resolve(".cache/dsh-home/dsh-mail/web"), service = new MailService({ directory, transport: { close: async () => {} } });
try {
  if (service.store.get("settings", "fixture-seeded")) throw new Error("Fixtures already present; refusing duplicate import");
  const topics = ["[测试] 项目 A：十月份报价与交付计划", "[测试] 日本語資料：翻訳スケジュールの確認", "[测试] 会议邀请：周五项目进度沟通", "[测试] 一封主题很长的邮件，包含多个项目名称与跨部门协作事项，用于检查窄侧栏截断和完整正文标题显示", "[测试] 附件与内嵌图片预览", "[测试] 本周工作总结", "[测试] 新版本功能验收安排", "[测试] 离线缓存与邮件导出"];
  const attachment = await service.upload({ filename: "验收说明.txt", contentType: "text/plain", base64: Buffer.from("这是合成的验收附件，不含真实邮件。\n附件保存与导出测试。").toString("base64") });
  const image = await service.upload({ filename: "示例.png", contentType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=" });
  let ids = [];
  for (const [index, subject] of topics.entries()) {
    const compiled = await composeDraft({ to: "user@example.invalid", subject, text: `这是 DSH Mail 的合成测试邮件 ${index + 1}。\n\n项目预计周五完成初稿。请确认报价和时间安排。\n日本語の添付資料もご確認ください。\n\n所有内容仅用于界面验收。`, html: `<h2>${subject}</h2><p>这是合成测试邮件，请确认 <strong>报价</strong> 与交付安排。</p><table><tr><th>项目</th><th>日期</th></tr><tr><td>初稿</td><td>周五</td></tr></table><p>日本語の資料もご確認ください。</p><img src="https://example.invalid/pixel.png"><script>throw new Error('unsafe fixture')</script>`, attachments: index === 4 ? [{ id: attachment.id }, { id: image.id }] : index % 3 === 0 ? [{ id: attachment.id }] : [] }, { email: `client${index}@example.invalid`, name: ["项目经理", "佐藤", "产品团队"][index % 3] }, (id) => service.ensureAttachment(id));
    const result = await service.importMail({ base64: compiled.raw.toString("base64"), folderName: "收件箱（测试数据）" }); ids.push(...result.ids);
  }
  const folder = service.folder(service.message(ids[0]).folderId); service.store.put("folders", { ...folder, role: "\\Inbox", count: ids.length });
  await service.folderOperation({ operation: "create", accountId: "local", path: "项目 A" }, { kind: "human" });
  await service.messageAction(ids[0], { operation: "star", value: true }); await service.messageAction(ids[1], { operation: "read", value: true }); await service.messageAction(ids[0], { operation: "label", value: ["项目 A"] });
  service.saveResource("labels", { name: "项目 A", color: "#155e75" }); service.saveResource("contacts", { name: "测试客户", email: "client0@example.invalid", group: "项目 A" });
  service.saveResource("tasks", { title: "[测试] 确认项目报价并安排交付", due: "2026-10-30T18:00:00+08:00", priority: "high", sourceMessageId: ids[0], evidence: "项目预计周五完成初稿" });
  service.saveEvent({ title: "[测试] 项目交付沟通", start: "2026-10-30T14:00:00+08:00", end: "2026-10-30T15:00:00+08:00", timeZone: "Asia/Hong_Kong", sourceMessageId: ids[0], rrule: "FREQ=WEEKLY;COUNT=4" });
  service.store.put("accounts", { id: "compose-fixture", name: "写信界面测试（未连接）", email: "user@example.invalid", enabled: false });
  service.saveDraft({ accountId: "compose-fixture", to: "client0@example.invalid", cc: "colleague@example.invalid", subject: "[测试] 回复报价：周五交付", text: "您好，\n\n我们会在周五前完成初稿。\n\n此邮件为界面验收用合成草稿。", attachments: [{ id: attachment.id }], requestReceipt: true });
  service.store.put("settings", { id: "fixture-seeded", ids }); console.log(JSON.stringify({ directory, messages: ids.length }));
} finally { await service.close(); }
