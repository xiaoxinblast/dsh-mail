// Synthetic mail only, confined to the repository-local isolated profile.
import { fileURLToPath } from "node:url";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
const service = new MailService({ directory: fileURLToPath(new URL("../.cache/dsh-home/dsh-mail/web", import.meta.url)), transport: { close: async () => {} } });
try {
  const accountId = "conversation-ui";
  service.store.put("accounts", { ...normalizeAccount({ id: accountId, name: "邮件往来验收", email: "threads@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", imapPort: 9, smtpPort: 9 }), authFailed: true, nextSyncAt: Date.now() + 86400000, folders: { sent: "conversation-sent" } });
  for (const [id, path, role] of [["conversation-inbox", "INBOX", "\\Inbox"], ["conversation-sent", "往来验收 / 已发送", "\\Sent"], ["conversation-project", "往来验收 / 项目副本", undefined]]) service.store.put("folders", { id, accountId, path, name: path, role });
  let uid = 0;
  const html = '<h2>确认交付安排</h2><p>直接在正文中查看<a href="https://mail-links.example.invalid/project?a=1&amp;b=2" target="_top" onclick="window.mailScriptRan=true">项目资料</a>，或打开<a href="http://mail-links.example.invalid/help">帮助页面</a>。</p><p><a href="javascript:window.mailScriptRan=true">脚本链接</a> / <a href="data:text/html,unsafe">数据链接</a> / <a href="file:///C:/Windows/win.ini">本地文件链接</a> / <a href="https://">无效网页链接</a></p><script>window.mailScriptRan=true</script><form><input name="secret"><button>提交</button></form>';
  const add = (id, value = {}) => service.store.upsertMessage({ id, accountId, folderId: "conversation-inbox", uid: ++uid, uidValidity: "1", messageId: `<${id}@example.invalid>`, subject: "[验收] 交付计划与报价确认", date: new Date(Date.UTC(2026, 9, 30, 0, uid)).toISOString(), text: "项目资料 https://mail-links.example.invalid/plain", html, bodyLoaded: true, from: [{ name: "客户 · 林乔", address: "client@example.invalid" }], to: [{ address: "threads@example.invalid" }], cc: [], flags: [], attachments: [], ...value });
  const root = add("conversation-root");
  add("conversation-copy", { messageId: root.messageId, folderId: "conversation-project", date: root.date });
  add("conversation-reply", { folderId: "conversation-sent", subject: "Re: [验收] 交付计划与报价确认", references: [root.messageId], from: [{ name: "我的回复", address: "threads@example.invalid" }] });
  add("conversation-last", { subject: "回复：Re: [验收] 交付计划与报价确认", inReplyTo: "<conversation-reply@example.invalid>" });
  const duplicate = add("conversation-only-copy-root", { subject: "[验收] 仅有文件夹副本" });
  add("conversation-only-copy", { messageId: duplicate.messageId, subject: duplicate.subject, folderId: "conversation-project", date: duplicate.date });
  add("conversation-changed", { subject: "[验收] 改为另一个项目", references: [root.messageId] });
  const long = add("conversation-long", { subject: "[验收] 长邮件往来" });
  for (let i = 0; i < 60; i++) add(`conversation-long-${i}`, { subject: "Re: [验收] 长邮件往来", folderId: "conversation-sent", references: [long.messageId] });
  console.log("Seeded isolated conversation, duplicate-copy, changed-subject and body-link fixtures");
} finally { await service.close(); }
