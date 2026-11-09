// Isolated real App + MailService exercise. All data and transports are synthetic.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { MailService } from "../src/service.mjs";
import { normalizeAccount, composeDraft } from "../src/mail.mjs";
import { simpleParser } from "mailparser";
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
const linkedMessage = service.store.upsertMessage({ ...message, id: undefined, uid: 2, messageId: "<mailto@example.invalid>", subject: "[验收] 项目联系人", text: "请联系项目经理。", html: '<p>请<a href="mailto:contact%2Bproject&#64;example.invalid?bcc=hidden%40example.invalid&amp;subject=Injected"><strong>联系项目经理</strong></a>，或查看<a href="https://mail-links.example.invalid/project">项目网页</a>。</p><p><a href="mailto:contact@example.invalid%0d%0a">含换行的地址</a> · <a href="mailto:broken%ZZ@example.invalid">无效编码</a> · <a data-mail-recipient="forged@example.invalid" href="javascript:void(0)">伪造操作</a></p>' });
const separator1 = "—— 2026-11-04T08:21:44.000Z previous@example.invalid ——", separator2 = "— 2026-11-03T12:00:00+09:00 older@example.invalid —";
const flatText = `今回の返信：翻訳が完了しました。\n\n${separator1}\n前回のメール：ご確認をお願いします。\n\n${separator2}\n以前のメール：日程について。`;
const flatFixtures = [
  ["paragraphs", `<div><p>今回の返信：翻訳が完了しました。</p><p>——&nbsp;<span>2026-11-04T08:21:44.000Z</span>\n<span> previous@example.invalid ——</span></p><p>前回のメール：ご確認をお願いします。</p><p>${separator2}</p><p>以前のメール：日程について。</p></div>`],
  ["breaks", `<div>今回の返信：翻訳が完了しました。<br><br>${separator1}<br>前回のメール：ご確認をお願いします。<br><a href="https://example.invalid/quoted?x=1&amp;y=2">元のリンク</a><br>${separator2}<br><strong>以前のメール：日程について。</strong></div>`],
  ["table", `<table><tbody><tr><td><p>今回の返信：翻訳が完了しました。</p><p>${separator1}</p><p>前回のメール：ご確認をお願いします。</p><p>${separator2}</p><p>以前のメール：日程について。</p></td></tr></tbody></table>`]
].map(([kind, html], i) => service.store.upsertMessage({ ...message, id: undefined, uid: 20 + i, messageId: `<flat-${kind}@example.invalid>`, subject: `[验收] HTML 引用分区 ${kind}`, text: flatText, html }));
const legacyDraft = service.saveDraft({ accountId: "me", to: "client@example.invalid", subject: "[验收] 旧回复草稿边界", sourceMessageId: flatFixtures[0].id, text: flatText, html: flatFixtures[0].html });
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
const open = async (subject = message.subject) => { await root.getByRole("button", { name: "邮件", exact: true }).click(); await root.locator("button.dm-message").filter({ hasText: subject }).click(); await expect(root.locator(".dm-reader h2")).toHaveText(subject); };
const generate = async (instruction = "") => { await panel.getByLabel("写作或处理要求（可选）").or(panel.getByLabel("回复要求（可选）")).fill(instruction); await panel.getByRole("button", { name: /^(生成|重新生成)$/ }).click(); await expect(panel.getByLabel("AI 生成正文（可编辑）")).toBeVisible(); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await open(linkedMessage.subject);
  const linkFrame = root.frameLocator('iframe[title="邮件正文"]');
  const mailLink = linkFrame.getByRole("button", { name: "联系项目经理", exact: true });
  await expect(mailLink).toHaveAttribute("title", "contact+project@example.invalid");
  await expect(linkFrame.locator("[data-mail-recipient]")).toHaveCount(1);
  for (const name of ["含换行的地址", "无效编码", "伪造操作"]) await expect(linkFrame.getByText(name, { exact: true })).not.toHaveAttribute("href", /.+/);
  await page.context().route("https://mail-links.example.invalid/project", (route) => route.fulfill({ contentType: "text/plain; charset=utf-8", body: "合成项目网页" }));
  const [projectPage] = await Promise.all([page.waitForEvent("popup"), linkFrame.getByRole("link", { name: "项目网页" }).click()]);
  await expect(projectPage.locator("body")).toHaveText("合成项目网页"); await projectPage.close();
  await shot("mailto-reader");
  for (const activate of [() => mailLink.click(), () => mailLink.press("Enter")]) {
    await activate();
    await expect(composer.getByLabel("收件人", { exact: true })).toHaveValue("contact+project@example.invalid");
    await expect(composer.getByLabel("主题", { exact: true })).toHaveValue("");
    await shot("mailto-composer");
    await composer.getByRole("button", { name: "← 关闭", exact: true }).click();
    await open(linkedMessage.subject);
  }
  const linkDrafts = service.store.list("drafts").filter((draft) => draft.to?.[0]?.address === "contact+project@example.invalid");
  assert.equal(linkDrafts.length, 2);
  assert.ok(linkDrafts.every((draft) => !draft.bcc?.length && draft.status === "draft"));
  checks.push("HTML mailto opens a local draft by mouse and keyboard, prefills the decoded recipient only, and keeps unsafe and web links isolated");
  for (const fixture of flatFixtures) {
    await root.getByRole("button", { name: "邮件", exact: true }).click(); await root.locator("button.dm-message").filter({ hasText: fixture.subject }).click();
    const content = root.frameLocator('iframe[title="邮件正文"]'); await expect(content.locator("section[data-mail-history]")).toHaveCount(2);
    await expect(content.locator("section[data-mail-history]").first()).toContainText("前回のメール"); await expect(content.locator("section[data-mail-history]").last()).toContainText("以前のメール");
    await expect(content.locator("section[data-mail-history]").first()).not.toContainText("以前のメール"); await expect(content.locator("section[data-mail-history]").last()).not.toContainText("前回のメール");
    await expect(content.locator(".dm-quote-heading").first()).toContainText("previous@example.invalid"); await expect(content.locator(".dm-quote-heading").last()).toContainText("older@example.invalid");
    assert.equal((await content.locator("body").innerText()).split("今回の返信：翻訳が完了しました。").length, 2);
    assert.ok(await content.locator("section[data-mail-history]").first().evaluate((e) => parseFloat(getComputedStyle(e).borderLeftWidth) >= 4));
    if (fixture.subject.endsWith("breaks")) await expect(content.getByRole("link", { name: "元のリンク" })).toHaveAttribute("target", "_blank");
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await shot(`flat-${fixture.subject.split(" ").at(-1)}-${width}`); }
    await root.getByLabel("更多邮件操作").click(); await root.getByRole("button", { name: "显示纯文本", exact: true }).click();
    await expect(root.locator(".dm-mail-body .dm-quoted-message")).toHaveCount(2); await expect(root.locator(".dm-quoted-message").last()).toContainText("以前のメール");
    await root.locator(".dm-quoted-message").first().locator("summary").click(); await expect(root.locator(".dm-quoted-message").first()).not.toHaveAttribute("open");
  }
  await root.getByRole("button", { name: "草稿与发件箱", exact: true }).click(); await root.locator("button.dm-message").filter({ hasText: legacyDraft.subject }).click();
  await expect(composer.locator(".tiptap")).toHaveText("今回の返信：翻訳が完了しました。");
  await expect(composer.frameLocator('iframe[title="回复引用原文"]').locator("section[data-mail-history]")).toHaveCount(2);
  await composer.getByRole("button", { name: "保存草稿", exact: true }).click(); const preserved = service.store.get("drafts", legacyDraft.id); assert.equal(preserved.text, flatText); assert.equal((preserved.html.match(/前回のメール/g) || []).length, 1);
  await composer.getByRole("button", { name: "← 关闭", exact: true }).click(); await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push("flat HTML timestamp/email boundaries split across spans, BRs and tables form distinct preserved quote cards; old rich drafts separate without duplication");
  await open();
  await expect(root.locator(".dm-reader-heading")).toContainText("client@example.invalid"); await expect(root.locator(".dm-reader-heading")).toContainText("me@example.invalid"); await expect(root.locator(".dm-reader-heading")).toContainText("Doe, Jane");
  const header = root.locator(".dm-reader-sticky"), top = (await header.boundingBox()).y;
  await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = 900); assert.ok(Math.abs((await header.boundingBox()).y - top) < 2);
  const aiMenu = root.getByLabel("邮件 AI 工具", { exact: true }), readerPane = root.locator(".dm-detail-pane");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const position of [900, "bottom"]) {
      await readerPane.evaluate((el, value) => el.scrollTop = value === "bottom" ? el.scrollHeight : value, position);
      assert.ok(await readerPane.evaluate((el) => el.scrollTop > 500), "long mail actually scrolled");
      await expect(aiMenu).toBeInViewport(); await aiMenu.click();
      const menu = root.locator(".dm-reader-ai .dm-menu-panel"), menuBounds = await menu.boundingBox(), paneBounds = await readerPane.boundingBox();
      assert.ok(menuBounds.x >= paneBounds.x && menuBounds.x + menuBounds.width <= paneBounds.x + paneBounds.width && menuBounds.y + menuBounds.height <= 900, "AI menu fits the reading viewport");
      await expect(menu.getByRole("button")).toHaveCount(3); await shot(`ai-menu-${width}-${position}`);
      await menu.getByRole("button", { name: "总结邮件", exact: true }).click(); await expect(root.locator(".dm-reader-ai")).not.toHaveAttribute("open");
      await expect(panel).toBeVisible(); await expect.poll(async () => (await panel.boundingBox()).y - ((await header.boundingBox()).y + (await header.boundingBox()).height)).toBeGreaterThanOrEqual(0);
      await expect(panel.getByLabel("AI 操作")).toBeFocused(); await expect(panel.getByLabel("AI 操作")).toBeInViewport(); await expect(panel.getByLabel("AI 生成正文（可编辑）")).toBeVisible();
      await shot(`ai-summary-${width}-${position}`);
    }
    await panel.getByRole("button", { name: "关闭邮件内 AI" }).click();
    await aiMenu.focus(); await aiMenu.press("Enter"); await expect(root.locator(".dm-reader-ai")).toHaveAttribute("open");
    await aiMenu.press("Escape"); await expect(root.locator(".dm-reader-ai")).not.toHaveAttribute("open"); await expect(aiMenu).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await readerPane.evaluate((el) => el.scrollTop = el.scrollHeight);
  await aiMenu.click(); await root.getByRole("button", { name: "翻译本邮件", exact: true }).click();
  await expect(panel.getByLabel("AI 操作")).toHaveValue("translateMessage"); await expect(panel.getByLabel("AI 操作")).toBeInViewport(); await expect(panel.getByLabel("AI 生成正文（可编辑）")).toBeVisible();
  await panel.getByRole("button", { name: "关闭邮件内 AI" }).click(); await readerPane.evaluate((el) => el.scrollTop = 900);
  checks.push("AI menu stays reachable after middle/end scrolling at three widths, fits the viewport, reveals new/existing results and supports keyboard open/Escape");
  const frame = root.frameLocator('iframe[title="邮件正文"]'); await expect(frame.locator("[data-mail-history]")).toContainText("更早回复"); assert.equal(await page.evaluate(() => window.emailScriptRan), undefined);
  await shot("reader-sticky-light");
  await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = 0);
  await root.getByLabel("更多邮件操作").click(); await root.getByRole("button", { name: "显示纯文本", exact: true }).click(); await expect(root.locator(".dm-mail-body .dm-quoted")).toContainText("上一轮回复");
  checks.push("address fallbacks, quoted comma name, sticky heading, preserved HTML/plain quotation and script isolation");
  await root.getByLabel("邮件 AI 工具", { exact: true }).click(); await root.getByRole("button", { name: "AI 回复", exact: true }).click(); await expect(composer).toBeVisible();
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
  await composer.getByLabel("发送选项", { exact: true }).click();
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
  await root.getByRole("button", { name: "通知与任务", exact: true }).click(); await expect(root.getByRole("dialog")).toContainText("已发送"); await root.getByRole("dialog").getByText("发送记录与回执", { exact: true }).click(); await expect(root.getByRole("dialog")).toContainText("已完成发送"); await expect(root.getByRole("dialog")).toContainText("Re: " + message.subject); await root.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await root.getByRole("button", { name: "写邮件", exact: true }).click(); await composer.getByLabel("主题", { exact: true }).fill("[验收] 手工新草稿"); await composer.getByRole("button", { name: "纯文本", exact: true }).click(); await composer.getByLabel("邮件纯文本正文").fill("> 手工正文，不是回复引用"); await composer.getByRole("button", { name: "保存草稿", exact: true }).click(); await composer.getByRole("button", { name: "← 关闭", exact: true }).click(); await root.locator("button.dm-message").filter({ hasText: "[验收] 手工新草稿" }).click(); await expect(composer.getByLabel("邮件纯文本正文")).toHaveValue("> 手工正文，不是回复引用"); await composer.getByRole("button", { name: "富文本", exact: true }).click(); await expect(composer.locator(".tiptap")).toContainText("> 手工正文，不是回复引用"); await expect(composer.locator(".dm-quoted")).toHaveCount(0);
  await composer.getByRole("button", { name: "AI 写信", exact: true }).click(); await panel.getByLabel("写作或处理要求（可选）").fill("[slow]"); await panel.getByRole("button", { name: "生成", exact: true }).click(); await panel.getByRole("button", { name: "取消生成", exact: true }).click(); await expect(panel.locator(".dm-ai-result")).toHaveCount(0);
  await panel.getByLabel("写作或处理要求（可选）").fill("[fail]"); await panel.getByRole("button", { name: "生成", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("合成模型失败"); await generate();
  checks.push("persistent zoned schedule, preview and queue status, cancel before delivery, sent excluded while failed/uncertain retained");
  await composer.getByRole("button", { name: "AI 写信", exact: true }).click();
  await composer.getByRole("button", { name: "抄送 / 密送", exact: true }).click();
  await composer.getByLabel("抄送", { exact: true }).fill("copy@example.invalid");
  await composer.getByLabel("密送", { exact: true }).fill("hidden@example.invalid");
  await composer.getByRole("button", { name: "抄送 / 密送", exact: true }).click();
  await composer.getByLabel("添加附件", { exact: true }).setInputFiles({ name: "合成交付说明.txt", mimeType: "text/plain", buffer: Buffer.from("synthetic attachment") });
  await expect(composer.locator(".dm-compose-attachments")).toContainText("合成交付说明.txt");
  await composer.getByRole("button", { name: "保存草稿", exact: true }).click();
  const attachmentDraft = service.store.list("drafts").find((d) => d.subject === "[验收] 手工新草稿");
  assert.equal(attachmentDraft.cc, "copy@example.invalid"); assert.equal(attachmentDraft.bcc, "hidden@example.invalid"); assert.equal(attachmentDraft.attachments.length, 1);
  const footer = composer.locator(".dm-compose-footer"), footerTop = (await footer.boundingBox()).y;
  await composer.locator(".tiptap").fill("正文区域\n".repeat(100));
  await composer.locator(".dm-compose-scroll").evaluate((el) => el.scrollTop = el.scrollHeight);
  assert.ok(Math.abs((await footer.boundingBox()).y - footerTop) < 2);
  await expect(composer.getByRole("button", { name: "预览并发送 →", exact: true })).toBeInViewport();
  await composer.getByLabel("发送选项", { exact: true }).click(); await expect(composer.getByLabel("发送方式")).toBeInViewport();
  await composer.getByLabel("发送方式").press("Escape"); await expect(composer.locator(".dm-compose-options")).not.toHaveAttribute("open");
  await composer.locator(".tiptap").fill("您好，\n\n附件是本次交付说明，请查收。\n如需调整，请直接回复这封邮件。\n\n谢谢！");
  await composer.locator(".dm-compose-scroll").evaluate((el) => el.scrollTop = 0);
  checks.push("collapsed CC/BCC persist; attachments remain in the fixed dock; long-body scrolling keeps send/options visible; Escape closes the options popup");
  await composer.getByLabel("收件人", { exact: true }).fill("client@example.invalid");
  await composer.locator(".tiptap").press("ControlOrMeta+A");
  await composer.getByLabel("字体", { exact: true }).selectOption("Arial");
  await composer.getByLabel("字号", { exact: true }).selectOption("20px");
  await composer.getByLabel("文字颜色", { exact: true }).click(); await composer.getByLabel("自定义文字颜色", { exact: true }).fill("#b91c1c"); await composer.getByLabel("自定义文字颜色").press("Escape");
  await composer.getByLabel("背景高亮", { exact: true }).click(); await composer.getByRole("button", { name: "背景高亮：黄色", exact: true }).click();
  for (const name of ["粗体", "斜体", "下划线", "删除线"]) {
    const button = composer.getByRole("button", { name, exact: true });
    await expect(button).toHaveAttribute("title", name); await expect(button).toHaveText("");
    await button.click(); await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await composer.getByRole("button", { name: "保存草稿", exact: true }).click();
  const formatted = service.store.get("drafts", attachmentDraft.id);
  assert.match(formatted.html, /font-family: Arial/); assert.match(formatted.html, /font-size: 20px/); assert.match(formatted.html, /color: rgb\(185, 28, 28\)/); assert.match(formatted.html, /background-color: rgb\(255, 242, 168\)/);
  const mime = await composeDraft(formatted, service.account("me"), (id) => service.ensureAttachment(id));
  const delivered = await simpleParser(mime.raw); assert.equal(delivered.html, formatted.html); assert.equal(delivered.attachments.length, 1);
  await shot("formatting-colors-light");
  await composer.getByRole("button", { name: "← 关闭", exact: true }).click();
  await root.locator("button.dm-message").filter({ hasText: "[验收] 手工新草稿" }).click();
  await composer.locator(".tiptap").press("ControlOrMeta+A");
  await expect(composer.getByLabel("字体", { exact: true })).toHaveValue("Arial"); await expect(composer.getByLabel("字号", { exact: true })).toHaveValue("20px");
  await expect(composer.locator(".tiptap span").first()).toHaveCSS("color", "rgb(185, 28, 28)");
  await composer.getByRole("button", { name: "清除格式", exact: true }).click(); await expect(composer.locator(".tiptap span")).toHaveCount(0);
  await composer.getByRole("button", { name: "撤销", exact: true }).click(); await expect(composer.locator(".tiptap span").first()).toHaveCSS("font-size", "20px");
  await composer.getByRole("button", { name: "重做", exact: true }).click(); await expect(composer.locator(".tiptap span")).toHaveCount(0);
  for (const name of ["无序列表", "有序列表"]) { await composer.locator(".tiptap").press("ControlOrMeta+Home"); const button = composer.getByRole("button", { name, exact: true }); await button.click(); await expect(button).toHaveAttribute("aria-pressed", "true"); await button.click(); }
  await composer.getByRole("button", { name: "纯文本", exact: true }).click(); await expect(composer.getByLabel("字体", { exact: true })).toBeDisabled();
  await composer.getByRole("button", { name: "富文本", exact: true }).click();
  await composer.getByLabel("模板与签名", { exact: true }).click(); await expect(composer.getByLabel("插入模板")).toBeVisible(); await composer.getByLabel("插入签名").press("Escape");
  checks.push("icon formatting controls expose hover labels and active states; fonts, size, color, highlight and marks survive save/reopen and MIME; clear/undo/redo, lists and plain-text disabling work");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.body.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(200);
    const contrast = await composer.getByRole("button", { name: "AI 写信", exact: true }).evaluate((el) => {
      const style = getComputedStyle(el), ctx = document.createElement("canvas").getContext("2d");
      const light = (color) => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); const c = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
      const a = light(style.color), b = light(style.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    }); assert.ok(contrast >= 4.5, `${theme} AI label contrast ${contrast}`);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 }); await shot(`compose-${theme}-${width}`);
      assert.ok(await root.evaluate((e) => e.scrollWidth <= e.clientWidth), "no workspace horizontal overflow");
      await composer.getByLabel("发送选项", { exact: true }).click();
      const popup = composer.locator(".dm-compose-options .dm-menu-panel"), bounds = await popup.boundingBox(), parent = await composer.boundingBox();
      assert.ok(bounds.x >= parent.x && bounds.x + bounds.width <= parent.x + parent.width, "send options fit the composer");
      await shot(`options-${theme}-${width}`); await composer.getByLabel("发送方式").press("Escape");
      await composer.getByLabel("文字颜色", { exact: true }).click();
      const palette = composer.locator(".dm-format-palette[open] .dm-menu-panel"), paletteBounds = await palette.boundingBox();
      assert.ok(paletteBounds.x >= parent.x && paletteBounds.x + paletteBounds.width <= parent.x + parent.width, "color palette fits the composer");
      await shot(`palette-${theme}-${width}`); await composer.getByLabel("自定义文字颜色").press("Escape");
    }
  }
  await composer.getByRole("button", { name: "← 关闭", exact: true }).click(); await open();
  await page.setViewportSize({ width: 1440, height: 1000 }); await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = e.scrollHeight); await shot("reader-quote-boundary"); await root.locator(".dm-detail-pane").evaluate((e) => e.scrollTop = 0);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.body.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(200);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await shot(`read-${theme}-${width}`); assert.ok((await header.boundingBox()).height < 900 * .43); }
  }
  await root.getByLabel("邮件 AI 工具", { exact: true }).click(); await root.getByRole("button", { name: "AI 回复", exact: true }).focus(); await expect(root.getByRole("button", { name: "AI 回复", exact: true })).toBeFocused();
  assert.deepEqual(errors, []); assert.equal(sends, 0); checks.push("light/dark desktop and narrow rendering, keyboard AI focus, zero browser errors, zero SMTP calls");
  await writeFile(join(cache, "mail-experience-ui-verification.json"), JSON.stringify({ checks, pageErrors: errors, smtpCalls: sends }, null, 2)); console.log(JSON.stringify({ checks, pageErrors: errors, smtpCalls: sends }));
} catch (e) { await shot("failure"); await writeFile(join(cache, "experience-failure.txt"), await page.locator("body").innerText()); throw e; }
finally { await browser.close(); await new Promise((done) => server.close(done)); await service.close(); }
