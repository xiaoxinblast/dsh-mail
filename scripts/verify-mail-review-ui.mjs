// 本轮修复的界面验收：收件箱角标、会话合并、回复收件人、字体列表、发送预览。
// 独立合成数据库 + 真实 React App；不启动日常 Host，不读写用户邮箱数据。
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";

await mkdir(".cache/screenshots", { recursive: true });
const service = new MailService({ directory: await mkdtemp(resolve(".cache/mail-review-")), transport: { close: async () => {}, flags: async () => {} } });
service.store.put("accounts", { ...normalizeAccount({ id: "demo", name: "验收邮箱", email: "me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), authFailed: true, status: "connected", folders: { sent: "sent" } });
for (const [id, path, role] of [["inbox", "INBOX", "\\Inbox"], ["sent", "已发送", "\\Sent"], ["project", "项目A", ""], ["archive", "归档", ""], ["junk", "垃圾邮件", "\\Junk"]]) service.store.put("folders", { id, path, role, accountId: "demo", uidValidity: "1", selectable: true });
let uid = 0;
const add = (id, folderId, value = {}) => service.store.upsertMessage({ id, accountId: "demo", folderId, uid: ++uid, uidValidity: "1", messageId: `<${id}@review.invalid>`, date: new Date(Date.now() - (40 - uid * 10) * 3600000).toISOString(), subject: "项目交付确认", text: "合成正文", html: "<p>合成正文</p>", bodyLoaded: true, from: [{ name: "客户", address: "client@example.invalid" }], to: [{ name: "我", address: "me@example.invalid" }], cc: [], attachments: [], flags: [], ...value });
const root = add("root", "project", { date: "2026-11-20T08:00:00.000Z", flags: ["\\Seen", "\\Flagged"], text: "这是最初的原始邮件正文。", html: "<p>这是最初的原始邮件正文。</p>" });
const reply1 = add("reply1", "sent", { messageId: "<reply1@review.invalid>", inReplyTo: "<root@review.invalid>", references: ["<root@review.invalid>"], date: "2026-11-20T09:00:00.000Z", from: [{ name: "我", address: "me@example.invalid" }], to: [{ name: "客户", address: "client@example.invalid" }], flags: ["\\Seen"], text: "这是我第一次回复的正文。", html: "<p>这是我第一次回复的正文。</p>" });
const reply2 = add("reply2", "inbox", { messageId: "<reply2@review.invalid>", inReplyTo: "<reply1@review.invalid>", references: ["<root@review.invalid>", "<reply1@review.invalid>"], date: "2026-11-20T10:00:00.000Z", text: "客户后续回复的最新正文。", html: "<p>客户后续回复的最新正文。</p>" });
add("inbox-read", "inbox", { subject: "收件箱已读邮件", messageId: "<read@review.invalid>", date: "2026-11-19T08:00:00.000Z", flags: ["\\Seen"], text: "已读邮件", html: "<p>已读邮件</p>" });
add("archive-unread", "archive", { subject: "归档中的未读邮件", messageId: "<archive@review.invalid>", date: "2026-11-19T09:00:00.000Z", text: "归档未读", html: "<p>归档未读</p>" });
await service.invoke({ action: "settings.save", value: { theme: "light", groupThreads: false, pageSize: 50 } }, { kind: "human" });
service.start();
const built = await build({ stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';import{App} from'./ui/workbench.jsx';const call=async(_id,operation,signal)=>{const r=await fetch('/api',{method:'POST',body:JSON.stringify(operation),signal});const v=await r.json();if(v.fixtureError)throw new Error(v.fixtureError);return v;};createRoot(document.getElementById('root')).render(<App sessionId='review-ui' call={call}/>);", resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
    if (req.url === "/api") { const chunks = []; for await (const chunk of req) chunks.push(chunk); const args = JSON.parse(Buffer.concat(chunks).toString() || "{}"); const result = await service.invoke(args, { kind: "human", sessionId: "review-ui" }); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return; }
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH Mail 修复验收</title><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#d7dce5;--dsw-alias-label-primary:#17212b;--dsw-alias-label-secondary:#5a6675;--dsw-alias-brand-primary:#2563eb;--dsw-alias-state-error-primary:#c44555}body{margin:0;font:14px system-ui}#root{height:100vh}</style><div id="root"></div><script src="/client.js"></script></html>');
  } catch (error) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ fixtureError: error.message })); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true }), checks = [], errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => { await page.goto(url); await page.locator(".dsh-mail").waitFor(); await page.waitForTimeout(700); };
  const rootLocator = () => page.locator(".dsh-mail");
  const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: `.cache/screenshots/review-${name}.png` }); };
  const rail = () => rootLocator().getByRole("navigation", { name: "功能导航" });
  const mailbox = async (name) => { await rail().getByRole("button", { name, exact: true }).click(); await page.waitForTimeout(600); };
  const openFolder = async (name) => { await rail().getByRole("button", { name: "邮箱与文件夹", exact: true }).click(); await rootLocator().locator(".dm-folder-row>button").filter({ hasText: name }).click(); await page.waitForTimeout(500); };

  await open();
  const badge = rootLocator().locator(".dm-rail-mail button").first().locator(".dm-rail-badge");
  await expect(badge).toHaveText("1");
  assert.equal(await rootLocator().locator(".dm-rail-mail button").first().getAttribute("title"), "统一收件箱 · 1 封未读");
  checks.push("收件箱角标只统计 INBOX 未读：只有 1 封收件箱未读，归档未读不计");

  await openFolder("项目A");
  await expect(rootLocator().locator(".dm-message-row")).toHaveCount(1);
  assert.ok((await rootLocator().locator(".dm-message-row").innerText()).includes("这是最初的原始邮件正文"), "unmerged folder row keeps the original mail");
  await expect(rootLocator().locator(".dm-thread-count")).toHaveCount(0);
  await shot("thread-off");
  checks.push("未开启会话合并时，项目文件夹只显示原始邮件");

  await rail().getByRole("button", { name: "设置", exact: true }).click();
  await rootLocator().getByRole("button", { name: "邮件与阅读", exact: true }).click();
  const toggle = rootLocator().locator(".dm-setting-switch").filter({ hasText: "按会话合并" }).locator("input");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await rootLocator().getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(rootLocator().locator(".dm-settings-save [role=status]")).toContainText("已保存");
  await shot("thread-setting");
  checks.push("设置中心提供「邮件列表按会话合并（显示最新回复）」开关并持久化");

  await open();
  await openFolder("项目A");
  await expect(rootLocator().locator(".dm-message-row")).toHaveCount(1);
  const rowText = await rootLocator().locator(".dm-message-row").innerText();
  assert.ok(rowText.includes("客户后续回复的最新正文"), "session row shows the latest reply snippet");
  await expect(rootLocator().locator(".dm-thread-count")).toHaveText("会话 3 封");
  await shot("thread-on");
  checks.push("开启会话合并后，文件夹中该行显示会话最新回复并标注「会话 3 封」");

  await rootLocator().locator(".dm-message-row .dm-message").click();
  await expect(rootLocator().locator(".dm-reader h2")).toHaveText("项目交付确认");
  const bodyFrame = rootLocator().locator(".dm-mail-body iframe");
  await expect(bodyFrame).toHaveCount(1);
  await expect.poll(async () => bodyFrame.evaluate((el) => el.contentDocument?.body?.innerText || ""), { timeout: 8000 }).toContain("客户后续回复的最新正文");
  const conversation = rootLocator().locator(".dm-conversation");
  await expect(conversation.locator("summary")).toContainText("共 3 封");
  if (!(await conversation.evaluate((el) => el.open))) await conversation.locator("summary").click();
  await expect(conversation.locator(".dm-conversation-items>button")).toHaveCount(3);
  await shot("thread-reader");
  await expect(badge).toHaveCount(0);
  await shot("badge-zero");
  checks.push("合并行打开会话最新邮件；阅读往来含 3 封；打开后收件箱角标归零（归档未读不再误显示）");

  await service.invoke({ action: "settings.save", value: { groupThreads: false } }, { kind: "human" });
  await open();
  await mailbox("已发送");
  await expect(rootLocator().locator(".dm-message-row")).toHaveCount(1);
  assert.ok((await rootLocator().locator(".dm-message-row").innerText()).includes("这是我第一次回复的正文"), "sent view lists the mail I sent");
  await rootLocator().locator(".dm-message-row .dm-message").click();
  await expect(rootLocator().locator(".dm-reader h2")).toHaveText("项目交付确认");
  await rootLocator().getByRole("button", { name: "回复", exact: true }).click();
  await expect(rootLocator().getByLabel("收件人", { exact: true })).toHaveValue('"客户" <client@example.invalid>');
  await shot("reply-recipient");
  checks.push("回复自己发出的已发送邮件时，默认收件人是原收件人而不是自己");

  await rootLocator().getByRole("button", { name: "← 关闭", exact: true }).click();
  await rail().getByRole("button", { name: "邮件", exact: true }).click();
  await rootLocator().getByRole("button", { name: "写邮件", exact: true }).click();
  const font = rootLocator().locator(".dm-font-family");
  await expect(font).toBeVisible();
  const fontGroups = await font.locator("optgroup").evaluateAll((groups) => groups.map((group) => [group.label, [...group.querySelectorAll("option")].map((option) => option.textContent)]));
  assert.deepEqual(fontGroups.map(([label]) => label), ["通用", "简体中文", "日本語"]);
  assert.ok(fontGroups[2][1].includes("游ゴシック") && fontGroups[2][1].includes("メイリオ") && fontGroups[2][1].includes("ＭＳ ゴシック"));
  await font.evaluate((el) => { el.style.maxHeight = "320px"; });
  await shot("fonts");
  await font.evaluate((el) => { el.style.maxHeight = ""; });
  await font.selectOption("Yu Gothic");
  await expect(font).toHaveValue("Yu Gothic");
  checks.push("写信字体菜单按通用/简体中文/日本語分组，并补充游ゴシック、メイリオ、ＭＳ ゴシック等日语字体");

  await rootLocator().getByLabel("收件人", { exact: true }).fill("client@example.invalid");
  await rootLocator().getByLabel("主题", { exact: true }).fill("发送预览验收");
  const editor = rootLocator().locator(".dm-editor [contenteditable=true]");
  await editor.click();
  await page.keyboard.type("第一段预览正文。");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二段预览正文。");
  await rootLocator().getByRole("button", { name: "预览并发送 →", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h2")).toHaveText("发送预览");
  const dialogText = await dialog.innerText();
  assert.ok(dialogText.includes("收件人") && dialogText.includes("发送时间"));
  assert.ok(!dialogText.includes("纯文本正文") && !dialogText.includes("HTML 正文"), "plain-text section removed");
  await expect(dialog.locator(".dm-send-card iframe")).toHaveCount(1);
  await expect(dialog.locator(".dm-send-card")).toContainText("client@example.invalid");
  await shot("preview-light");
  const iframeHeight = await dialog.locator(".dm-send-body iframe").evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(iframeHeight >= 160 && iframeHeight <= 430, `adaptive preview height ${iframeHeight}`);
  checks.push("发送预览改为邮件卡片（主题/发件人/收件人/时间 + 正文），不再显示重复的纯文本正文，正文高度按内容自适应");

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  await shot("preview-narrow");
  assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "narrow preview has no horizontal overflow");
  checks.push("390px 窄屏发送预览无横向溢出");

  await dialog.getByRole("button", { name: "取消操作", exact: true }).click();
  await service.invoke({ action: "settings.save", value: { theme: "dark" } }, { kind: "human" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open();
  await rootLocator().getByRole("button", { name: "写邮件", exact: true }).click();
  await rootLocator().getByLabel("收件人", { exact: true }).fill("client@example.invalid");
  await rootLocator().getByLabel("主题", { exact: true }).fill("深色发送预览");
  await rootLocator().locator(".dm-editor [contenteditable=true]").click();
  await page.keyboard.type("深色主题下的发送预览正文。");
  await rootLocator().getByRole("button", { name: "预览并发送 →", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot("preview-dark");
  checks.push("深色主题发送预览正常");

  await service.invoke({ action: "settings.save", value: { theme: "light" } }, { kind: "human" });
  assert.deepEqual(errors, []);
  await browser.close();
  await service.close();
  await new Promise((done) => server.close(done));
  console.log(JSON.stringify({ checks, pageErrors: errors }, null, 2));
  process.exit(0);
} catch (error) {
  await page?.screenshot({ path: ".cache/screenshots/review-failure.png" }).catch(() => {});
  console.error("FAILED", error.message, "pageErrors", JSON.stringify(errors));
  await browser.close().catch(() => {});
  await service.close().catch(() => {});
  process.exit(1);
}
