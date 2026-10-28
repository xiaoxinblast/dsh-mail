// Synthetic fixtures only, always inside this repository's isolated DSH profile.
import { fileURLToPath } from "node:url";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
const service = new MailService({ directory: fileURLToPath(new URL("../.cache/dsh-home/dsh-mail/web", import.meta.url)), transport: { close: async () => {} } });
try {
  service.store.put("accounts", { ...normalizeAccount({ id: "navigation-ui", name: "工作邮箱 · 界面验收", email: "demo@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", imapPort: 9, smtpPort: 9 }), authFailed: true, status: "connected", folders: { sent: "navigation-sent", archive: "navigation-archive", trash: "navigation-trash" } });
  const folders = [["navigation-inbox", "收件箱", "\\Inbox", 6], ["navigation-sent", "已发送", "\\Sent", 2], ["navigation-archive", "Archive", "\\Archive", 0], ["navigation-trash", "已删除", "\\Trash", 0], ["navigation-alpha", "Altagram", null, 12], ["navigation-gi", "GienTech", null, 1], ["navigation-lion", "Lionbridge", null, 36], ["navigation-pay", "Lionbridge Pay", null, 6], ["navigation-side", "Side", null, 23], ["navigation-tr", "Transperfect", null, 8], ["navigation-cn2", "项目/客户2", null, 0], ["navigation-cn10", "项目/客户10", null, 10]];
  for (const [id, path, role, count] of folders) service.store.put("folders", { id, accountId: "navigation-ui", name: path.split("/").at(-1), path, delimiter: "/", role, count, selectable: true, uidValidity: "1", color: ({ "navigation-alpha": "#db2777", "navigation-lion": "#2563eb", "navigation-side": "#d97706" })[id] || "" });
  const topics = ["十月项目交付计划与报价确认", "日本語資料：翻訳スケジュールの確認", "周五进度沟通 · 会议资料已准备", "设计稿评审：请确认新的工作台布局", "本周交付清单与附件整理", "Re: 客户反馈及下一步安排"];
  for (let i = 0; i < 8; i++) service.store.upsertMessage({ id: `navigation-message-${i}`, accountId: "navigation-ui", folderId: i < 6 ? "navigation-inbox" : "navigation-sent", uidValidity: "1", uid: i + 1, date: new Date(Date.parse("2026-10-29T09:30:00+08:00") - i * 1800000).toISOString(), subject: i < 6 ? topics[i] : "已发送 · 确认交付时间 " + (i - 5), from: [{ name: ["林乔", "佐藤 美咲", "产品团队", "沈宁", "Project Desk", "王远"][i % 6], address: `client${i}@example.invalid` }], to: [{ address: "demo@example.invalid" }], text: "您好，\n\n这是一封合成验收邮件。请核对项目报价及交付时间，初稿将在周五前完成。\n\n日本語の資料もご確認ください。\n\n所有内容仅用于本机界面验收。", html: "<p>您好，</p><p>这是一封<strong>合成验收邮件</strong>。请核对项目报价及交付时间，初稿将在周五前完成。</p><p>日本語の資料もご確認ください。</p><p>所有内容仅用于本机界面验收。</p>", bodyLoaded: true, seen: i % 3 === 0, starred: i === 1, attachments: [], flags: [] });
  service.store.put("settings", { ...service.settings(), id: "general", folderSort: "name-asc", defaultAccountId: "navigation-ui", markReadOnOpen: false });
  service.saveDraft({ id: "navigation-draft", accountId: "navigation-ui", to: "client@example.invalid", subject: "[验收] 回复交付计划", text: "您好，\n我们将在周五前完成初稿。\n此草稿仅用于界面验收。" });
  console.log("Seeded only synthetic navigation fixtures in repository-local isolated profile");
} finally { await service.close(); }
