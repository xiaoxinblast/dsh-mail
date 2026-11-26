// 本轮修复的界面验收：规则目标与当前文件夹相同时仍可打开邮件；发送预览的确认按钮固定在对话框底部。
// 独立合成数据库 + 真实 React App；不启动日常 Host，不读写用户邮箱数据。
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
import { validateRule } from "../src/rules.mjs";

await mkdir(".cache/screenshots", { recursive: true });
const service = new MailService({ directory: await mkdtemp(resolve(".cache/mail-open-preview-")), transport: { close: async () => {}, flags: async () => {} } });
service.store.put("accounts", { ...normalizeAccount({ id: "demo", name: "验收邮箱", email: "me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), authFailed: true, status: "connected", folders: { sent: "sent" } });
for (const [id, path, role] of [["inbox", "INBOX", "\\Inbox"], ["side", "Side", ""], ["sent", "已发送", "\\Sent"]]) service.store.put("folders", { id, path, role, accountId: "demo", uidValidity: "1", selectable: true });
const stuck = service.store.upsertMessage({ id: "stuck", accountId: "demo", folderId: "side", uid: 1, uidValidity: "1", messageId: "<stuck@review.invalid>", date: "2026-11-26T08:00:00.000Z", subject: "已在 Side 的客户邮件", text: "邮件已经在 Side 文件夹，规则不应再阻塞打开。", html: "<p>邮件已经在 Side 文件夹，规则不应再阻塞打开。</p>", bodyLoaded: true, rulesPending: true, from: [{ name: "客户", address: "client@example.invalid" }], to: [{ name: "我", address: "me@example.invalid" }], cc: [], attachments: [], flags: [] });
service.store.put("rules", { ...validateRule({ name: "客户邮件复制到 Side", accountId: "demo", conditions: [{ field: "from", operator: "contains", value: "client@example.invalid" }], actions: [{ action: "copy", destinationId: "side" }] }), enabled: true });
const longHtml = `<div style="font-size:14px;line-height:1.8">${Array.from({ length: 36 }, (_, i) => `<p style="margin:0 0 12px">第 ${i + 1} 段：这是一封用于验证发送预览底部操作栏的合成长邮件，正文足够长以让对话框产生滚动。</p>`).join("")}</div>`;
const draft = service.saveDraft({ accountId: "demo", to: "client@example.invalid", subject: "长正文发送预览验收", html: longHtml, text: Array.from({ length: 36 }, (_, i) => `第 ${i + 1} 段：这是一封用于验证发送预览底部操作栏的合成长邮件。`).join("\n\n") });
await service.invoke({ action: "settings.save", value: { theme: "light", pageSize: 50 } }, { kind: "human" });
service.start();
const built = await build({ stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';import{App} from'./ui/workbench.jsx';const call=async(_id,operation,signal)=>{const r=await fetch('/api',{method:'POST',body:JSON.stringify(operation),signal});const v=await r.json();if(v.fixtureError)throw new Error(v.fixtureError);return v;};createRoot(document.getElementById('root')).render(<App sessionId='open-preview-ui' call={call}/>);", resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
    if (req.url === "/api") { const chunks = []; for await (const chunk of req) chunks.push(chunk); const args = JSON.parse(Buffer.concat(chunks).toString() || "{}"); const result = await service.invoke(args, { kind: "human", sessionId: "open-preview-ui" }); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return; }
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH Mail 修复验收</title><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#d7dce5;--dsw-alias-label-primary:#17212b;--dsw-alias-label-secondary:#5a6675;--dsw-alias-brand-primary:#2563eb;--dsw-alias-state-error-primary:#c44555}body{margin:0;font:14px system-ui}#root{height:100vh}</style><div id="root"></div><script src="/client.js"></script></html>');
  } catch (error) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ fixtureError: error.message })); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "msedge", headless: true }), checks = [], errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => { await page.goto(url); await page.locator(".dsh-mail").waitFor(); await page.waitForTimeout(700); };
  const rootLocator = () => page.locator(".dsh-mail");
  const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: `.cache/screenshots/open-preview-${name}.png` }); };

  await open();
  await rootLocator().getByRole("button", { name: "邮箱与文件夹", exact: true }).click();
  await rootLocator().locator(".dm-folder-row>button").filter({ hasText: "Side" }).click();
  await page.waitForTimeout(500);
  await rootLocator().locator(".dm-message-row .dm-message").filter({ hasText: "已在 Side 的客户邮件" }).click();
  await expect(rootLocator().locator(".dm-reader h2")).toHaveText("已在 Side 的客户邮件");
  await expect(rootLocator().locator(".dm-empty h2").filter({ hasText: "邮件暂时无法打开" })).toHaveCount(0);
  await expect.poll(async () => (await service.invoke({ action: "message.read", id: stuck.id }, { kind: "agent" })).rulesPending ?? false).toBe(false);
  assert.equal(service.store.folderMessages("side").length, 1, "same-folder rule must not create a duplicate");
  await shot("mail-open");
  checks.push("规则目标与邮件当前文件夹相同时按已完成处理，邮件正常打开且不产生重复副本");

  await rootLocator().getByRole("button", { name: "草稿与发件箱", exact: true }).click();
  await page.waitForTimeout(500);
  await rootLocator().locator(".dm-message-list .dm-message").filter({ hasText: "长正文发送预览验收" }).click();
  await expect(rootLocator().getByRole("button", { name: "预览并发送 →", exact: true })).toBeVisible();
  await rootLocator().getByRole("button", { name: "预览并发送 →", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("h2")).toHaveText("发送预览");
  await expect.poll(() => dialog.evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true);
  const footer = dialog.locator("footer");
  const confirm = dialog.getByRole("button", { name: "确认发送", exact: true });
  await expect(confirm).toBeVisible();
  const geometry = async (stage) => {
    const measured = await dialog.evaluate((el) => { const rect = el.getBoundingClientRect(), footer = el.querySelector(".dm-send-preview>footer"), button = [...footer.querySelectorAll("button")].find((item) => item.textContent.includes("确认发送")); return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, dialogTop: rect.top, dialogBottom: rect.bottom, footerPosition: getComputedStyle(footer).position, buttonTop: button.getBoundingClientRect().top, buttonBottom: button.getBoundingClientRect().bottom }; });
    assert.equal(measured.footerPosition, "sticky", `${stage}: footer must be sticky`);
    assert.ok(measured.buttonTop >= measured.dialogTop && measured.buttonBottom <= measured.dialogBottom, `${stage}: 确认发送不在对话框可视区域内 ${JSON.stringify(measured)}`);
    return measured;
  };
  const top = await geometry("顶部");
  assert.equal(top.scrollTop, 0);
  await shot("preview-top");
  await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  await geometry("底部");
  await shot("preview-bottom");
  checks.push("长正文发送预览打开时“确认发送”固定在对话框底部，无需滚动即可点击；滚到底部仍保持可见");

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  await dialog.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(200);
  const narrow = await geometry("窄屏");
  assert.ok(narrow.dialogBottom <= 800, "窄屏对话框不超出视口");
  assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "窄屏发送预览无横向溢出");
  await shot("preview-narrow");
  checks.push("390px 窄屏下发送预览底部操作栏仍固定可见且无横向溢出");

  assert.deepEqual(errors, []);
  await browser.close();
  await service.close();
  await new Promise((done) => server.close(done));
  console.log(JSON.stringify({ checks, pageErrors: errors, draft: draft.id }, null, 2));
  process.exit(0);
} catch (error) {
  await page?.screenshot({ path: ".cache/screenshots/open-preview-failure.png" }).catch(() => {});
  console.error("FAILED", error.message, "pageErrors", JSON.stringify(errors));
  await browser.close().catch(() => {});
  await service.close().catch(() => {});
  process.exit(1);
}
