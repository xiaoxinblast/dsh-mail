// Isolated real App + MailService exercise. All data and transports are synthetic.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { MailService } from "../src/service.mjs";
import { normalizeAccount } from "../src/mail.mjs";
const cache = resolve(".cache"); await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, "experience-ui-"));
let sends = 0;
const service = new MailService({ directory, transport: { close: async () => {}, send: async () => { sends++; throw new Error("No SMTP in UI verification"); } }, ai: async ({ instruction, signal }) => {
  if (instruction.includes("[slow]")) await new Promise((done, reject) => { const timer = setTimeout(done, 800); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  if (instruction.includes("[fail]")) throw new Error("合成模型失败");
  return { subject: "AI 合成主题", text: "AI 合成正文\n请核对后应用。", model: "isolated/fixture" };
} });
service.store.put("accounts", { ...normalizeAccount({ id: "me", email: "me@example.invalid", imapHost: "127.0.0.1", smtpHost: "127.0.0.1" }), authFailed: true });
service.store.put("folders", { id: "inbox", accountId: "me", path: "INBOX", role: "\\Inbox" });
const message = service.store.upsertMessage({ accountId: "me", folderId: "inbox", uid: 1, uidValidity: "1", messageId: "<experience@example.invalid>", from: [{ name: '""', address: "client@example.invalid" }], to: [{ name: '" "', address: "me@example.invalid" }], cc: [{ name: '"Doe, Jane"', address: "jane@example.invalid" }], subject: "[验收] 阅读与写信体验", date: new Date().toISOString(), bodyLoaded: true, seen: true, flags: ["\\Seen"], attachments: [], text: "本次回复：请核对交付时间。\n".repeat(60) + "\nOn Tuesday, client wrote:\n> 上一轮回复\n>> 更早回复", html: "<p>本次回复：请核对交付时间。</p>".repeat(60) + '<div class="gmail_quote"><p>上一轮回复</p><blockquote>更早回复</blockquote></div><script>window.emailScriptRan=true</script>' });
for (const status of ["sent", "failed", "uncertain", "discarded"]) service.store.put("drafts", { id: `fixture-${status}`, accountId: "me", to: "client@example.invalid", subject: `fixture ${status}`, text: "synthetic", status });
const entry = join(cache, "experience-entry.jsx");
await writeFile(entry, `import React from 'react';import{createRoot}from'react-dom/client';import{App}from'../ui/workbench.jsx';createRoot(document.getElementById('root')).render(<App call={async(_id,operation,signal)=>{const r=await fetch('/api',{method:'POST',body:JSON.stringify(operation),signal});const v=await r.json();if(v.error)throw new Error(v.error);return v;} } prompt={async()=>''}/>);`);
const built = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
const client = built.outputFiles[0].text;
const server = createServer(async (req, res) => {
  if (req.url === "/client.js") { res.setHeader("Content-Type", "text/javascript"); res.end(client); return; }
  if (req.url === "/api") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const controller = new AbortController(); res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try { const result = await service.invoke(JSON.parse(Buffer.concat(chunks)), { kind: "human", signal: controller.signal }); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); } catch (e) { res.end(JSON.stringify({ error: e.message })); } return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<!doctype html><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f5f6fa;--dsw-alias-border-l2:#d7dce5;--dsw-alias-label-primary:#17212b;--dsw-alias-label-secondary:#5a6675;--dsw-alias-brand-primary:#2563eb;--dsw-alias-state-error-primary:#b91c1c}body{margin:0;font:14px system-ui}#root{height:100vh}body.dark{--dsw-alias-bg-layer-1:#191c24;--dsw-alias-bg-layer-2:#252a36;--dsw-alias-border-l2:#444c60;--dsw-alias-label-primary:#f1f3fa;--dsw-alias-label-secondary:#aeb8ce;color-scheme:dark}</style><div id="root"></div><script src="/client.js"></script>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000); const errors = [], checks = []; page.on("pageerror", (e) => errors.push(e.message));
const shots = join(cache, "screenshots"); await mkdir(shots, { recursive: true });
const root = page.locator(".dsh-mail"), composer = root.locator(".dm-composer"), panel = root.getByRole("region", { name: "邮件内 AI" });
const shot = (name) => page.screenshot({ path: join(shots, `experience-${name}.png`), fullPage: true });
const open = async () => { await root.getByRole("button", { name: "邮件", exact: true }).click(); await root.locator("button.dm-message").filter({ hasText: message.subject }).click(); await expect(root.locator(".dm-reader h2")).toHaveText(message.subject); };
const generate = async (instruction = "") => { await panel.getByLabel("写作或处理要求（可选）").or(panel.getByLabel("回复要求（可选）")).fill(instruction); await panel.getByRole("button", { name: /^(生成|重新生成)$/ }).click(); await expect(panel.getByLabel("AI 生成正文（可编辑）")).toBeVisible(); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await open();
  await expect(root.locator(".dm-reader-heading")).toContainText("client@example.invalid"); await expect(root.locator(".dm-reader-heading")).toContainText("me@example.invalid"); await expect(root.locator(".dm-reader-heading")).toContainText("Doe, Jane");
  const header = root.locator(".dm-reader-sticky"), top = (await header.boundingBox()).y;
  await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = 900); assert.ok(Math.abs((await header.boundingBox()).y - top) < 2);
  const frame = root.frameLocator('iframe[title="邮件正文"]'); await expect(frame.locator("[data-mail-history]")).toContainText("更早回复"); assert.equal(await page.evaluate(() => window.emailScriptRan), undefined);
  await shot("reader-sticky-light");
  await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = 0);
  await root.getByLabel("更多邮件操作").click(); await root.getByRole("button", { name: "显示纯文本", exact: true }).click(); await expect(root.locator(".dm-mail-body .dm-quoted")).toContainText("上一轮回复");
  checks.push("address fallbacks, quoted comma name, sticky heading, preserved HTML/plain quotation and script isolation");
  await root.getByRole("button", { name: "AI 回复", exact: true }).click(); await expect(composer).toBeVisible();
  await expect(composer.getByLabel("收件人", { exact: true })).toHaveValue("client@example.invalid"); await expect(composer.locator(".tiptap")).not.toContainText("上一轮回复");
  await panel.getByLabel("回复要求（可选）").fill("[slow]"); await panel.getByRole("button", { name: "生成", exact: true }).click(); await composer.locator(".tiptap").fill("较新的用户输入"); await expect(panel.getByLabel("AI 生成正文（可编辑）")).toBeVisible();
  await panel.getByRole("button", { name: "应用正文", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("草稿已经改变"); await expect(composer.locator(".tiptap")).toHaveText("较新的用户输入");
  await generate(); await panel.getByLabel("AI 生成正文（可编辑）").fill("编辑后的 AI 回复"); await shot("ai-reply-edit-light");
  await panel.getByRole("button", { name: "应用正文", exact: true }).click(); await expect(composer.locator(".tiptap")).toHaveText("编辑后的 AI 回复");
  await expect(composer.frameLocator('iframe[title="回复引用原文"]').locator("body")).toContainText("更早回复");
  await composer.getByRole("button", { name: "纯文本", exact: true }).click(); await expect(composer.getByLabel("邮件纯文本正文")).toHaveValue("编辑后的 AI 回复"); await composer.getByLabel("邮件纯文本正文").fill("第一行\n> 本次输入符号\n第二行\n");
  await composer.getByRole("button", { name: "保存草稿", exact: true }).click();
  const saved = service.store.list("drafts").find((d) => d.sourceMessageId === message.id); assert.match(saved.text, /第一行\n> 本次输入符号\n第二行\n/); assert.equal(saved.text.split("——").length, 3);
  checks.push("AI reply shares composer, edited results apply explicitly, newer user input protected, quote preserved across rich/plain saves");
  await composer.getByLabel("发送方式").selectOption("scheduled"); await composer.getByLabel("发送时区").selectOption("Asia/Tokyo");
  const local = DateTime.now().setZone("Asia/Tokyo").plus({ days: 2 }).toFormat("yyyy-MM-dd'T'HH:mm"); await composer.getByLabel("计划发送时间").fill(local);
  await composer.getByRole("button", { name: "保存草稿", exact: true }).click(); await composer.getByRole("button", { name: "← 关闭", exact: true }).click();
  await root.getByRole("button", { name: "草稿与发件箱", exact: true }).click(); await expect(root.locator(".dm-message-list")).not.toContainText("fixture sent"); await expect(root.locator(".dm-message-list")).not.toContainText("fixture discarded"); await expect(root.locator(".dm-message-list")).toContainText("fixture failed"); await expect(root.locator(".dm-message-list")).toContainText("fixture uncertain");
  await root.locator("button.dm-message").filter({ hasText: "Re: " + message.subject }).click(); await expect(composer.getByLabel("计划发送时间")).toHaveValue(local); await expect(composer.getByLabel("发送时区")).toHaveValue("Asia/Tokyo");
  await composer.getByRole("button", { name: "预览并发送 →", exact: true }).click(); const dialog = root.getByRole("dialog"); await expect(dialog).toContainText("Asia/Tokyo"); await expect(dialog).toContainText("错过时间后须重新确认");
  await dialog.getByRole("button", { name: "确认发送", exact: true }).click();
  await root.locator("button.dm-message").filter({ hasText: "Re: " + message.subject }).click(); await expect(composer).toContainText("已排队");
  await composer.getByRole("button", { name: "取消发送", exact: true }).click(); await expect(composer.getByLabel("发送方式")).toHaveValue("now");
  const completed = service.store.get("drafts", saved.id); service.store.put("drafts", { ...completed, status: "sent", accepted: ["client@example.invalid"] });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("dsh-mail:workbench", { detail: {} })));
  await expect(composer).toHaveCount(0); await expect(root.locator(".dm-message-list")).not.toContainText("Re: " + message.subject);
  await root.getByRole("button", { name: "通知与任务", exact: true }).click(); await expect(root.getByRole("dialog")).toContainText("已完成发送"); await expect(root.getByRole("dialog")).toContainText("Re: " + message.subject); await root.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await root.getByRole("button", { name: "写邮件", exact: true }).click(); await composer.getByLabel("主题", { exact: true }).fill("[验收] 手工新草稿"); await composer.getByRole("button", { name: "纯文本", exact: true }).click(); await composer.getByLabel("邮件纯文本正文").fill("> 手工正文，不是回复引用"); await composer.getByRole("button", { name: "保存草稿", exact: true }).click(); await composer.getByRole("button", { name: "← 关闭", exact: true }).click(); await root.locator("button.dm-message").filter({ hasText: "[验收] 手工新草稿" }).click(); await expect(composer.locator(".tiptap")).toContainText("> 手工正文，不是回复引用"); await expect(composer.locator(".dm-quoted")).toHaveCount(0);
  await composer.getByRole("button", { name: "AI 写信", exact: true }).click(); await panel.getByLabel("写作或处理要求（可选）").fill("[slow]"); await panel.getByRole("button", { name: "生成", exact: true }).click(); await panel.getByRole("button", { name: "取消生成", exact: true }).click(); await expect(panel.locator(".dm-ai-result")).toHaveCount(0);
  await panel.getByLabel("写作或处理要求（可选）").fill("[fail]"); await panel.getByRole("button", { name: "生成", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("合成模型失败"); await generate();
  checks.push("persistent zoned schedule, preview and queue status, cancel before delivery, sent excluded while failed/uncertain retained");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.body.classList.toggle("dark", dark), theme === "dark");
    const contrast = await composer.getByRole("button", { name: "AI 写信", exact: true }).evaluate((el) => {
      const style = getComputedStyle(el), ctx = document.createElement("canvas").getContext("2d");
      const light = (color) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const c = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
      const a = light(style.color), b = light(style.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    }); assert.ok(contrast >= 4.5, `${theme} AI label contrast ${contrast}`);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 }); await shot(`compose-${theme}-${width}`);
      assert.ok(await root.evaluate((e) => e.scrollWidth <= e.clientWidth), "no workspace horizontal overflow");
    }
  }
  await composer.getByRole("button", { name: "← 关闭", exact: true }).click(); await open();
  await page.setViewportSize({ width: 1440, height: 1000 }); await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = e.scrollHeight); await shot("reader-quote-boundary"); await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = 0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.body.classList.toggle("dark", dark), theme === "dark");
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await shot(`read-${theme}-${width}`); assert.ok((await header.boundingBox()).height < 900 * .43); }
  }
  await root.getByRole("button", { name: "AI 回复", exact: true }).focus(); await expect(root.getByRole("button", { name: "AI 回复", exact: true })).toBeFocused();
  assert.deepEqual(errors, []); assert.equal(sends, 0); checks.push("light/dark desktop and narrow rendering, keyboard AI focus, zero browser errors, zero SMTP calls");
  await writeFile(join(cache, "mail-experience-ui-verification.json"), JSON.stringify({ checks, pageErrors: errors, smtpCalls: sends }, null, 2)); console.log(JSON.stringify({ checks, pageErrors: errors, smtpCalls: sends }));
} catch (e) { await shot("failure"); await writeFile(join(cache, "experience-failure.txt"), await page.locator("body").innerText()); throw e; }
finally { await browser.close(); await new Promise((done) => server.close(done)); await service.close(); }
