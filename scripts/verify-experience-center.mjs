// Real React/App + MailService rendering. All accounts and data are synthetic.
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
await mkdir(".cache/screenshots", { recursive: true });
const service = new MailService({ directory: await mkdtemp(resolve(".cache/center-ui-")), transport: { close: async () => {}, flags: async () => {}, test: async () => ({ imap: true, smtp: true }) } });
service.store.put("accounts", { ...normalizeAccount({ id: "demo", name: "项目协作", email: "demo@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), status: "connected", lastSyncedAt: new Date().toISOString(), nextSyncAt: Date.now() + 120000 });
service.store.put("folders", { id: "inbox", accountId: "demo", path: "INBOX", role: "\\Inbox" });
service.store.put("folders", { id: "projects", accountId: "demo", path: "项目交付", color: "#7c3aed" });
for (let i = 0; i < 120; i++) service.store.upsertMessage({ id: `center-${i}`, accountId: "demo", folderId: "inbox", uidValidity: "1", uid: i + 1, messageId: `<center-${i}@example.invalid>`, subject: ["十一月项目交付安排", "设计稿确认与下一步计划", "本周协作进度", "关于产品说明书的更新"][i % 4] + ` ${i}`, date: new Date(Date.now() - i * 3600000).toISOString(), from: [{ name: ["山田", "设计团队", "项目经理"][i % 3], address: `client${i}@example.invalid` }], to: [{ address: "demo@example.invalid" }], text: "你好，附件与项目计划已经准备好。请确认最新的交付时间，我们会继续推进。", html: "<h2>项目安排</h2><p>你好，新的项目计划已准备完成。</p><p>请确认最新交付时间与下一步安排。</p><blockquote>上一轮确认：周三提交预览稿。</blockquote>", attachments: [], flags: i % 3 ? ["\\Seen"] : [], bodyLoaded: true });
for (let i = 0; i < 70; i++) service.store.put("contacts", { id: `person-${i}`, name: `协作联系人 ${i}`, email: `person${i}@example.invalid`, group: i % 2 ? "设计" : "项目" });
for (let i = 0; i < 8; i++) service.store.put("tasks", { id: `task-${i}`, title: ["确认交付清单", "检查设计稿", "准备周报", "回复客户进度"][i % 4], due: new Date(Date.now() + (i - 2) * 3600000).toISOString(), priority: i === 0 ? "high" : "normal", done: i > 5 });
service.store.put("signatures", { id: "signature", name: "工作签名", text: "祝好，\n项目协作团队" });
service.store.put("templates", { id: "template", name: "交付确认", subject: "项目交付确认", text: "你好，项目已完成本轮交付，请确认附件内容。如有修改意见，欢迎回复。" });
service.store.put("rules", { id: "rule", name: "重要客户邮件", enabled: false, priority: 0, match: "all", conditions: [{ field: "subject", operator: "contains", value: "交付" }], actions: [{ action: "star", value: true }, { action: "task", title: "确认交付" }] });
service.saveEvent({ title: "项目进度会", start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString(), color: "#d7f8ec" });
service.addNotification("new-mail", "未读邮件", { accountId: "demo", messageIds: ["center-0", "center-3"] });
await service.download("临时邮件导出.eml", "message/rfc822", Buffer.from("synthetic"));
const built = await build({ stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';import{App}from'./ui/workbench.jsx';createRoot(document.getElementById('root')).render(<App call={async(_id,operation,signal)=>{const r=await fetch('/api',{method:'POST',body:JSON.stringify(operation),signal});const v=await r.json();if(v.error)throw new Error(v.error);return v;}}/>);", resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/api") { const chunks = []; for await (const c of req) chunks.push(c); const operation = JSON.parse(Buffer.concat(chunks)); requests.push(operation.action); try { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await service.invoke(operation, { kind: "human" }))); } catch (e) { res.end(JSON.stringify({ error: e.message })); } return; }
  res.setHeader("Content-Type", "text/html;charset=utf-8"); res.end('<!doctype html><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#d7dce5;--dsw-alias-label-primary:#17212b;--dsw-alias-label-secondary:#5a6675;--dsw-alias-brand-primary:#2563eb}body{margin:0;font:14px system-ui}#root{height:100vh}</style><div id="root"></div><script src="/client.js"></script>');
});
let browser, page; const errors = [], checks = [];
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(12000); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const root = page.locator(".dsh-mail"), rail = root.getByRole("navigation", { name: "功能导航" });
  const shot = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: `.cache/screenshots/center-${name}.png` }); };
  const noOverflow = async () => assert.ok(await root.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1), "No outer scrolling or horizontal overflow");
  await expect(root.locator(".dm-message-row")).toHaveCount(50); await shot("overview-light-1440");
  await root.getByRole("button", { name: "通知与任务", exact: true }).click();
  const alerts = root.getByRole("dialog", { name: "通知", exact: true }); await expect(alerts).toContainText("未读邮件 · 2 封"); await expect(alerts.getByRole("button", { name: "已知晓" })).toHaveCount(0); await shot("notifications-simple");
  await alerts.getByRole("button", { name: /未读邮件 · 2 封/ }).click(); await expect(root.locator(".dm-reader h2")).toContainText("十一月项目交付安排 0");
  await expect.poll(() => service.state().notifications[0]?.data.messageIds.length).toBe(1);
  await root.getByRole("button", { name: "通知与任务", exact: true }).click(); await alerts.getByRole("button", { name: /未读邮件 · 1 封/ }).click();
  await expect.poll(() => service.state().notifications.length).toBe(0); await expect(root.locator('.dm-rail-bottom [aria-label="通知与任务"] .dm-rail-badge')).toHaveCount(0);
  checks.push("compact mail status notifications disappear automatically on successful reading without a manual acknowledgment");
  await rail.getByRole("button", { name: "设置", exact: true }).click(); const nav = root.getByRole("navigation", { name: "设置分类" });
  await expect(nav.getByRole("button")).toHaveCount(9);
  await nav.getByLabel("搜索设置").fill("头像"); await expect(nav.getByRole("button")).toHaveCount(1); await nav.getByLabel("搜索设置").fill("");
  await nav.getByRole("button", { name: "外观与动效", exact: true }).click();
  await root.getByLabel("主题", { exact: true }).selectOption("dark"); await expect(page.locator(".dm-app")).toHaveAttribute("data-theme", "dark");
  assert.equal(service.settings().theme, "host"); await root.getByRole("button", { name: "取消修改", exact: true }).click(); await expect(page.locator(".dm-app")).toHaveAttribute("data-theme", "host");
  await root.getByLabel("主题", { exact: true }).selectOption("light"); await root.getByRole("button", { name: "保存设置", exact: true }).click(); await expect(root.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
  checks.push("nine settings categories, setting search, live appearance preview/cancel and saved preference");
  const categories = ["邮箱账号", "外观与动效", "邮件与阅读", "写信、签名与模板", "通知", "日历与待办", "AI 助手", "存储与备份", "诊断与关于"];
  for (const theme of ["light", "dark"]) {
    await nav.getByRole("button", { name: "外观与动效", exact: true }).click(); await root.getByLabel("主题", { exact: true }).selectOption(theme);
    if (await root.getByRole("button", { name: "保存设置", exact: true }).isEnabled()) await root.getByRole("button", { name: "保存设置", exact: true }).click();
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (let i = 0; i < categories.length; i++) { await nav.getByRole("button", { name: categories[i], exact: true }).click(); await noOverflow(); if (width === 1440 || width === 390) await shot(`settings-${i}-${theme}-${width}`); }
      for (const [name, id] of [["待办", "tasks"], ["联系人", "contacts"], ["规则", "rules"], ["日历", "calendar"], ["邮件", "mail"]]) {
        await rail.getByRole("button", { name, exact: true }).click(); await noOverflow(); await shot(`${id}-${theme}-${width}`);
      }
      await root.locator("button.dm-message").first().click(); await expect(root.locator(".dm-reader")).toBeVisible(); await noOverflow(); await shot(`reader-${theme}-${width}`);
      await rail.getByRole("button", { name: "设置", exact: true }).click();
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav.getByRole("button", { name: "邮件与阅读", exact: true }).click();
  await root.getByLabel("每页邮件数").selectOption("25"); await root.getByRole("switch", { name: "显示发件人头像", exact: true }).uncheck(); await root.getByLabel("邮件摘要", { exact: true }).selectOption("2"); await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await rail.getByRole("button", { name: "邮件", exact: true }).click(); await expect(root.locator(".dm-message-row")).toHaveCount(25); await expect(root.locator(".dm-message-list")).toHaveAttribute("data-avatars", "false"); await root.getByRole("button", { name: "下一页", exact: true }).click(); await expect(root.locator(".dm-pagination")).toContainText("26–50");
  await rail.getByRole("button", { name: "联系人", exact: true }).click(); await expect(root.locator(".dm-contact")).toHaveCount(50); await root.getByRole("button", { name: "下一页", exact: true }).click(); await expect(root.locator(".dm-contact")).toHaveCount(20); await root.getByLabel("搜索联系人").fill("person69@"); await expect(root.locator(".dm-contact")).toHaveCount(1);
  checks.push("bounded mail/contact pagination, avatar/summary preferences, contact search");
  await rail.getByRole("button", { name: "设置", exact: true }).click(); await nav.getByRole("button", { name: "外观与动效", exact: true }).click(); await root.getByLabel("界面密度").selectOption("compact"); await root.getByLabel("动态效果").selectOption("off"); await root.getByRole("button", { name: "强调色：青绿" }).click(); await root.getByRole("button", { name: "保存设置", exact: true }).click();
  await rail.getByRole("button", { name: "邮件", exact: true }).click(); await shot("compact-dark-1440"); await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(); await shot("compact-dark-390");
  await page.reload(); await expect(page.locator(".dm-app")).toHaveAttribute("data-theme", "dark"); await expect(page.locator(".dm-app")).toHaveAttribute("data-density", "compact"); await expect(page.locator(".dm-app")).toHaveAttribute("data-motion", "off");
  await page.setViewportSize({ width: 1440, height: 1000 }); await rail.getByRole("button", { name: "设置", exact: true }).click(); await nav.getByRole("button", { name: "存储与备份", exact: true }).click(); await root.getByRole("checkbox", { name: "选择全部临时导出" }).check(); await root.getByRole("button", { name: "预览清理", exact: true }).click(); await expect(root.getByRole("region", { name: "核对临时文件清理" })).toContainText("临时邮件导出.eml"); await shot("storage-confirm"); await root.getByRole("button", { name: "确认清理", exact: true }).click(); await expect(root.getByText("没有可清理的临时导出。", { exact: true })).toBeVisible();
  assert.equal(service.store.db.prepare("SELECT count(*) AS n FROM messages").get().n, 120);
  checks.push("persisted appearance/reduced motion, explicit cleanup preview and confirmation preserve messages");
  assert.deepEqual(errors, []); await writeFile(".cache/experience-center-verification.json", JSON.stringify({ checks, errors, requests: requests.reduce((a, k) => ({ ...a, [k]: (a[k] || 0) + 1 }), {}) }, null, 2)); console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) { await page?.screenshot({ path: ".cache/screenshots/center-failure.png" }); throw error; }
finally { await browser?.close(); await new Promise((r) => server.close(r)); await service.close(); }
